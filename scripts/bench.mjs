#!/usr/bin/env node
// Reference measurements (benchmarks/README.md): the same fixed requests, run through
// PEOS before and after a change to it, compared on cost, rework and how often the user
// was needed. It prepares a project for a task, collects the numbers of a finished run,
// and compares two labelled sets. It never starts a model: the run itself is the user's.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeUsage, usageFile } from './lib/usage.mjs';

const root = fileURLToPath(new URL('../benchmarks/', import.meta.url));
const stop = message => { process.stderr.write(`${message}\n`); process.exit(2); };
const read = path => readFile(path, 'utf8').catch(() => null);
const json = async path => { try { return JSON.parse(await read(path) ?? 'null'); } catch { return null; } };
const name = (value, what) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(value ?? '') ? value : stop(`${what} must use lowercase letters, digits and hyphens.`);

export function parseTask(source) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*?)(?:\n## Scoring\n([\s\S]*))?$/.exec(source);
  if (!match) return null;
  const fields = Object.fromEntries(match[1].split('\n').map(line => line.split(/:\s*/, 2)));
  return { ...fields, request: match[2].trim(), scoring: (match[3] ?? '').split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) };
}
async function task(id) {
  return parseTask(await read(resolve(root, 'tasks', `${name(id, '--task')}.md`)) ?? '') ?? stop(`No task ${id} in benchmarks/tasks.`);
}

// The numbers of one run, read from its directory. Rework is every evaluation round after
// the first and every failed check run: work that was done twice.
export async function collect(directory) {
  const state = await json(resolve(directory, 'state.json'));
  if (!state) return null;
  const usage = summarizeUsage(await json(resolve(directory, usageFile)), state.tier);
  const evals = Object.entries(state.evals ?? {});
  const answers = /^##[ \t]+Answers[ \t]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(await read(resolve(directory, 'idea.md')) ?? '')?.[1] ?? '';
  let nonBlocking = 0;
  for (const file of (await readdir(resolve(directory, 'evals')).catch(() => [])).filter(file => /^[a-z-]+\.json$/.test(file))) {
    nonBlocking += ((await json(resolve(directory, 'evals', file)))?.findings ?? []).filter(finding => ['medium', 'low'].includes(finding.severity)).length;
  }
  return { run: state.run, type: state.type, tier: state.tier, stage: state.stage,
    finished: ['release', 'done'].includes(state.stage),
    decisions: new Set(Object.values(state.gates ?? {}).filter(gate => gate.status === 'approved').map(gate => gate.at)).size,
    questions: answers.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(line => /\S/.test(line)).length,
    evaluations: evals.length, carried: evals.filter(([, entry]) => entry.carried).length,
    reworkRounds: evals.reduce((sum, [, entry]) => sum + entry.round - 1, 0) + (state.verifyFailures ?? 0),
    notPassed: evals.filter(([, entry]) => entry.verdict !== 'PASS').map(([key]) => key),
    nonBlockingFindings: nonBlocking,
    tokens: usage?.total ?? null, outputTokens: usage?.output ?? null, modelCalls: usage?.calls ?? null, budget: usage?.budget ?? null,
    byAgent: usage ? Object.fromEntries(Object.entries(usage.byAgent).map(([agent, use]) => [agent, use.total])) : null };
}

const million = value => value === null || value === undefined ? '—' : `${(value / 1e6).toFixed(1)}M`;
export function compare(before, after) {
  const rows = [];
  for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const [a, b] = [before[id], after[id]];
    const change = a?.tokens && b?.tokens ? `${b.tokens >= a.tokens ? '+' : ''}${Math.round(100 * (b.tokens - a.tokens) / a.tokens)}%` : '—';
    const pair = field => `${a?.[field] ?? '—'} → ${b?.[field] ?? '—'}`;
    rows.push(`${id}: tokens ${million(a?.tokens)} → ${million(b?.tokens)} (${change}), rework ${pair('reworkRounds')}, questions ${pair('questions')}, decisions ${pair('decisions')}, scored ${pair('scored')}, finished ${pair('finished')}`);
  }
  return rows;
}
async function results(label) {
  const directory = resolve(root, 'results', name(label, 'a label'));
  const set = {};
  for (const file of (await readdir(directory).catch(() => stop(`No results labelled ${label}.`))).filter(file => file.endsWith('.json'))) set[file.slice(0, -5)] = await json(resolve(directory, file));
  return set;
}

async function main([command, ...rest]) {
  const option = flag => { const index = rest.indexOf(`--${flag}`); return index < 0 ? undefined : rest[index + 1]; };
  if (command === 'list') {
    for (const file of (await readdir(resolve(root, 'tasks'))).filter(file => file.endsWith('.md')).sort()) {
      const entry = parseTask(await read(resolve(root, 'tasks', file)));
      process.stdout.write(`${entry.id} (${entry.expect}, fixture ${entry.fixture})\n`);
    }
  } else if (command === 'prepare') {
    const entry = await task(option('task'));
    const into = resolve(option('into') ?? stop('--into <new directory> is required.'));
    if ((await readdir(into).catch(() => [])).length) stop(`${into} is not empty.`);
    await mkdir(into, { recursive: true });
    if (entry.fixture === 'empty') await writeFile(resolve(into, 'README.md'), `# ${entry.id}\n`);
    else await cp(resolve(root, 'fixtures', name(entry.fixture, 'fixture')), into, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: into, stdio: 'ignore' });
    git('init', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=peos-bench', '-c', 'user.email=bench@localhost', 'commit', '-m', `Benchmark fixture for ${entry.id}`);
    process.stdout.write(`Project ready at ${into}\nInstall PEOS there (scripts/install.mjs --project), open a session in it and send:\n\n/peos:start ${entry.request}\n\nAnswer questions as a user would, approve what you would approve, and when the run ends:\n\nnode scripts/bench.mjs collect --task ${entry.id} --project ${into} --label <label> --scored <met>/${entry.scoring.length}\n\nScoring:\n${entry.scoring.map(line => `- ${line}`).join('\n')}\n`);
  } else if (command === 'collect') {
    const entry = await task(option('task'));
    const project = resolve(option('project') ?? stop('--project is required.'));
    const runs = resolve(project, '.project-os/runs');
    const run = option('run') ?? (await readdir(runs).catch(() => [])).filter(file => /^\d{4}-/.test(file)).sort().at(-1) ?? stop('The project has no run.');
    const numbers = await collect(resolve(runs, run)) ?? stop(`Run ${run} has no state.`);
    const scored = option('scored');
    if (scored !== undefined && !/^\d+\/\d+$/.test(scored)) stop('--scored is <criteria met>/<criteria>, for example 5/6.');
    const directory = resolve(root, 'results', name(option('label'), '--label'));
    await mkdir(directory, { recursive: true });
    const record = { task: entry.id, collectedAt: new Date().toISOString(), scored: scored ?? null, ...numbers };
    await writeFile(resolve(directory, `${entry.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${entry.id}: ${million(record.tokens)} tokens, ${record.reworkRounds} rework rounds, ${record.questions} questions, ${record.decisions} decisions, scored ${record.scored ?? 'not yet'} → benchmarks/results/${option('label')}/${entry.id}.json\n`);
  } else if (command === 'compare') {
    process.stdout.write(`${compare(await results(rest[0]), await results(rest[1])).join('\n')}\n`);
  } else stop('Usage: bench.mjs list | prepare --task <id> --into <dir> | collect --task <id> --project <dir> --label <label> [--run <run>] [--scored n/m] | compare <label> <label>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
