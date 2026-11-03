import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath as realpathOf, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { config, fixture, git, jsonCli, repository, saveConfig, toolkit } from './helpers.mjs';
import { detectChecks } from '../scripts/lib/setup.mjs';
import { sessionCalls, summarizeUsage, totals } from '../scripts/lib/usage.mjs';

const run = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]).report;
const commit = (project, message = 'change') => { git(project, 'add', '.'); git(project, 'commit', '-m', message); };

test('setup writes the configuration from the manifests and never overwrites it', async t => {
  const project = await repository(t);
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'next build' } }));
  await writeFile(resolve(project, 'pnpm-lock.yaml'), '');
  commit(project);
  const report = run(project, 'setup');
  assert.equal(report.config, 'created');
  assert.deepEqual(report.checks, ['tests: pnpm run test', 'typecheck: pnpm run typecheck', 'lint: pnpm run lint', 'build: pnpm run build']);
  assert.deepEqual(report.instructions, { 'AGENTS.md': 'missing', 'CLAUDE.md': 'missing' });
  assert.equal(report.profile.status, 'missing');
  const written = JSON.parse(await readFile(resolve(project, '.project-os/engineering.config.json'), 'utf8'));
  assert.equal(written.projectName, 'shop');
  assert.deepEqual(written.checks.find(entry => entry.id === 'build').phases, ['release']);
  await saveConfig(project, config());
  const existing = run(project, 'setup');
  assert.deepEqual([existing.config, existing.addedChecks], ['updated', ['typecheck: pnpm run typecheck', 'lint: pnpm run lint']]);
  const kept = JSON.parse(await readFile(resolve(project, '.project-os/engineering.config.json'), 'utf8'));
  assert.equal(kept.projectName, 'fixture', 'the rest of the configuration stays');
  assert.deepEqual(kept.checks.map(entry => entry.id).slice(-2), ['typecheck', 'lint']);
  assert.deepEqual([run(project, 'setup').config, run(project, 'setup').addedChecks], ['existing', []]);
});

test('setup moves checks AGENTS.md requires for code changes to the task phase', async t => {
  const project = await repository(t);
  await saveConfig(project, config([{ id: 'unit', executable: 'node', args: ['-e', '0'], phases: ['task'], required: true, timeoutMs: 1000 },
    { id: 'build', executable: 'npm', args: ['run', 'build'], phases: ['release'], required: true, timeoutMs: 1000 },
    { id: 'preview', executable: 'npm', args: ['run', 'preview'], phases: ['release'], required: true, timeoutMs: 1000 }]));
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ scripts: { build: 'x', preview: 'x', 'docs:check': 'x', 'check-format': 'x' } }));
  await writeFile(resolve(project, 'AGENTS.md'), 'pnpm preview is listed here.\nCode changes: `pnpm build`, `pnpm deploy`.\n');
  commit(project);
  const report = run(project, 'setup');
  assert.deepEqual(report.addedChecks, ['format: npm run check-format', 'docs: npm run docs:check', 'build: npm run build']);
  const { checks } = JSON.parse(await readFile(resolve(project, '.project-os/engineering.config.json'), 'utf8'));
  assert.deepEqual(checks.find(entry => entry.id === 'build').phases, ['task', 'release']);
  assert.deepEqual(checks.find(entry => entry.id === 'preview').phases, ['release'], 'only the code-change line counts');
  assert.ok(!checks.some(entry => entry.args.includes('deploy')), 'instructions never add a command');
  assert.equal(run(project, 'setup').config, 'existing');
});

test('setup leaves the configuration alone while a run is in progress', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
  commit(project);
  const { run: name } = run(project, 'init', ['--name', 'avatar', '--type', 'feature', '--tier', 'small']);
  const during = run(project, 'setup');
  assert.deepEqual([during.config, during.addedChecks, during.suggestedChecks], ['existing', [], ['lint: npm run lint']]);
  run(project, 'advance', ['--run', name, '--to', 'stopped']);
  assert.deepEqual(run(project, 'setup').addedChecks, ['lint: npm run lint']);
});

test('setup links CLAUDE.md to an existing AGENTS.md and never overwrites it', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  await writeFile(resolve(project, 'AGENTS.md'), '# Rules\n');
  assert.deepEqual(run(project, 'setup').instructions, { 'AGENTS.md': 'present', 'CLAUDE.md': 'created' });
  assert.equal(await readFile(resolve(project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  await writeFile(resolve(project, 'CLAUDE.md'), 'own rules\n');
  assert.deepEqual(run(project, 'setup').instructions, { 'AGENTS.md': 'present', 'CLAUDE.md': 'present' });
  assert.equal(await readFile(resolve(project, 'CLAUDE.md'), 'utf8'), 'own rules\n');
});

test('check detection covers package managers, placeholders and other ecosystems', async t => {
  const project = await repository(t);
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }));
  await writeFile(resolve(project, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
  assert.deepEqual((await detectChecks(project)).map(entry => [entry.id, entry.executable, ...entry.args]), [['build', 'npm', 'run', 'build']]);
  await writeFile(resolve(project, 'yarn.lock'), '');
  await writeFile(resolve(project, 'go.mod'), 'module example.com/x\n');
  assert.deepEqual((await detectChecks(project)).map(entry => [entry.id, entry.executable, ...entry.args]), [
    ['build', 'yarn', 'run', 'build'], ['tests', 'go', 'test', './...'], ['vet', 'go', 'vet', './...'], ['go-build', 'go', 'build', './...']]);
  await writeFile(resolve(project, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  assert.ok((await detectChecks(project)).some(entry => entry.executable === 'python3'), 'pytest configured');
  const empty = await repository(t);
  assert.equal(run(empty, 'setup').error.code, 'SETUP');
});

test('the profile goes stale when manifests or many files change', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  await writeFile(resolve(project, 'package.json'), '{}');
  commit(project);
  const head = git(project, 'rev-parse', 'HEAD').trim();
  await mkdir(resolve(project, '.project-os'), { recursive: true });
  await writeFile(resolve(project, '.project-os/project-profile.md'), `<!-- peos-profile head=${head} -->\n# Profile\n`);
  assert.equal(run(project, 'setup').profile.status, 'fresh');
  await writeFile(resolve(project, '.project-os/project-profile.md'), `\n\`\`\`markdown\n<!-- peos-profile head=${head} -->\n# Profile\n\`\`\`\n`);
  assert.equal(run(project, 'setup').profile.status, 'fresh', 'a kept code fence is tolerated');
  await writeFile(resolve(project, 'package.json'), '{"name":"x"}');
  commit(project);
  assert.deepEqual([run(project, 'setup').profile.status, run(project, 'setup').profile.reason], ['stale', 'a manifest changed']);
  await writeFile(resolve(project, '.project-os/project-profile.md'), '# Profile without a commit\n');
  assert.equal(run(project, 'setup').profile.status, 'stale');
});

// A host-shaped transcript: split assistant messages share an id and usage.
function call(id, at, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: at, message: { id, usage: { input_tokens: usage[0], output_tokens: usage[1], cache_creation_input_tokens: usage[2], cache_read_input_tokens: usage[3] } } });
}
test('usage counts each model call once across the session, its subagents and copies', async t => {
  const project = await repository(t);
  const transcript = resolve(project, 'session-1.jsonl');
  await writeFile(transcript, [call('m0', '2026-01-01T00:00:00Z', [9, 9, 9, 9]), call('m1', '2026-01-02T00:00:00Z', [1, 3, 100, 1000]),
    call('m1', '2026-01-02T00:00:00Z', [1, 10, 100, 1000]), 'not json'].join('\n'));
  await mkdir(resolve(project, 'session-1/subagents'), { recursive: true });
  // A fork's transcript repeats the parent's call m1.
  await writeFile(resolve(project, 'session-1/subagents/agent-a.jsonl'), [call('m1', '2026-01-02T00:00:00Z', [1, 10, 100, 1000]), call('s1', '2026-01-02T00:01:00Z', [2, 20, 200, 2000])].join('\n'));
  const calls = await sessionCalls(transcript, Date.parse('2026-01-01T12:00:00Z'));
  assert.deepEqual(totals(calls), { input: 3, output: 30, cacheWrite: 300, cacheRead: 3000, calls: 2, total: 3333 });
  const summary = summarizeUsage({ sessions: { a: '', b: '' }, calls: { ...calls, big: [0, 0, 0, 7_000_000] } }, 'standard');
  assert.deepEqual([summary.total, summary.calls, summary.sessions, summary.overBudget], [7_003_333, 3, 2, true]);
  assert.equal(summarizeUsage({ sessions: {}, calls: {} }, 'small'), null);
});

test('the Stop hook records usage for the run the session works on and status shows it', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  const { run: name, directory } = run(project, 'init', ['--name', 'avatar', '--type', 'feature', '--tier', 'small']);
  const transcript_path = resolve(project, 'session-2.jsonl');
  const now = new Date(Date.now() + 1000).toISOString();
  const own = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'node "/x/scripts/peos-run.mjs" init --name avatar --type feature --tier small --json' } }] } });
  await writeFile(transcript_path, [own, call('m1', now, [1, 2, 3, 4])].join('\n'));
  const result = spawnSync(process.execPath, [resolve(toolkit, 'hooks/usage-record.mjs')], {
    input: JSON.stringify({ cwd: project, transcript_path }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'never blocks');
  const record = JSON.parse(await readFile(resolve(directory, 'usage.json'), 'utf8'));
  assert.ok(record.sessions[basename(transcript_path, '.jsonl')]);
  assert.deepEqual(record.calls, { m1: [1, 2, 3, 4] });
  const status = run(project, 'status', ['--run', name]);
  assert.deepEqual([status.usage.total, status.usage.budget, status.usage.overBudget], [10, 3_000_000, false]);
});

test('record-eval consumes a report file the evaluator wrote into the run directory', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  const { run: name, directory } = run(project, 'init', ['--name', 'avatar', '--type', 'feature', '--tier', 'standard']);
  run(project, 'advance', ['--run', name, '--to', 'spec']);
  await writeFile(resolve(directory, 'spec.md'), 'spec');
  const subject = `sha256:${createHash('sha256').update('spec').digest('hex')}`;
  const report = JSON.stringify({ schemaVersion: 1, evaluator: 'spec', verdict: 'FAIL', mode: 'full', subject, criteria: [],
    findings: [{ id: 'F1', severity: 'high', problem: 'AC-1 is not observable.', impact: 'Nobody can test it.', fix: 'Name the observable result.' }], notAssessed: [] });
  const inside = resolve(directory, 'pending-eval-spec.json');
  await writeFile(inside, report.replace(subject, `sha256:${'0'.repeat(64)}`));
  assert.equal(run(project, 'record-eval', ['--run', name, '--report', inside]).error.code, 'STALE');
  assert.ok(await readFile(inside, 'utf8'), 'a rejected report stays for inspection');
  await writeFile(inside, report);
  const first = run(project, 'record-eval', ['--run', name, '--report', inside]);
  assert.deepEqual([first.round, first.plateau, first.nonBlocking, first.blocking.map(finding => finding.id)], [1, false, 0, ['F1']]);
  assert.equal(first.blocking[0].fix, 'Name the observable result.');
  await assert.rejects(readFile(inside), 'consumed once recorded');
  const outside = resolve(project, 'pending-eval-spec.json');
  await writeFile(outside, report);
  const second = run(project, 'record-eval', ['--run', name, '--report', outside]);
  assert.deepEqual([second.round, second.plateau], [2, true], 'same blocking findings twice');
  assert.equal(await readFile(outside, 'utf8'), report, 'files elsewhere are left alone');
  jsonCli('peos-run.mjs', ['grant', '--project', project, '--action', 'reset-eval', '--target', 'spec']);
  const reset = run(project, 'reset-eval', ['--run', name, '--key', 'spec']);
  assert.deepEqual(reset.last.blocking.map(finding => finding.problem), ['AC-1 is not observable.'], 'the cleared findings come back');
});

test('a spec over its criteria limit is reported and refused', async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  const { run: name, directory } = run(project, 'init', ['--name', 'avatar', '--type', 'change', '--tier', 'standard']);
  run(project, 'advance', ['--run', name, '--to', 'spec']);
  const spec = count => Array.from({ length: count }, (_, index) => `- AC-${index + 1}: behavior`).join('\n');
  const record = text => {
    const subject = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    return jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', name, '--report', '-'], { input: JSON.stringify({ schemaVersion: 1, evaluator: 'spec', verdict: 'PASS', mode: 'full', subject, criteria: [], findings: [], notAssessed: [] }) }).report;
  };
  await writeFile(resolve(directory, 'spec.md'), spec(11));
  assert.deepEqual(run(project, 'status', ['--run', name]).specSize, { criteria: 11, limit: 10, over: true });
  assert.equal(record(spec(11)).error.code, 'SPEC_SIZE');
  await writeFile(resolve(directory, 'spec.md'), spec(10));
  assert.equal(record(spec(10)).verdict, 'PASS');
});

test('install prepares a project once for every host and can be repeated', async t => {
  const project = await repository(t);
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  await writeFile(resolve(project, 'keep.txt'), 'mine');
  commit(project);
  const stub = await repository(t);
  const calls = resolve(stub, 'calls');
  await writeFile(resolve(stub, 'claude'), `#!/bin/sh\necho "$PWD $*" >> "${calls}"\n`);
  await chmod(resolve(stub, 'claude'), 0o755);
  const install = (path = `${stub}:${process.env.PATH}`) => jsonCli('install.mjs', ['--project', project], { env: { ...process.env, PATH: path } }).report;
  const first = install();
  assert.deepEqual([first.status, first.claude, first.instructions], ['PASS', 'installed', { 'AGENTS.md': 'present', 'CLAUDE.md': 'created' }]);
  const logged = (await readFile(calls, 'utf8')).trim().split('\n');
  assert.match(logged[0], /plugin marketplace add .* --scope local$/);
  assert.match(logged[1], /plugin install peos@peos-local --scope local$/);
  assert.ok(logged[0].startsWith(await realpathOf(project)), 'runs in the project');
  assert.match(await readFile(resolve(project, 'AGENTS.md'), 'utf8'), /personal-engineering-os:start/);
  assert.equal(await readFile(resolve(project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.ok(await readFile(resolve(project, '.agents/skills/peos-task-planning/SKILL.md'), 'utf8'));
  assert.equal(git(project, 'status', '--short', '--', '.project-os/toolkit', '.agents'), '', 'links stay out of commits');
  assert.equal(install().status, 'PASS');
  const exclude = await readFile(resolve(project, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter(line => line === '.project-os/toolkit').length, 1, 'repeating adds nothing');
  assert.equal(install(`/usr/bin:${dirname(process.execPath)}`).claude, 'skipped: claude is not installed');
  assert.equal(await readFile(resolve(project, 'keep.txt'), 'utf8'), 'mine');
});

test('install stops before changing a project it cannot set up', async t => {
  const project = await repository(t);
  await writeFile(resolve(project, 'readme.txt'), 'no manifest');
  commit(project);
  assert.equal(jsonCli('install.mjs', ['--project', project]).report.error.code, 'SETUP');
  await assert.rejects(readFile(resolve(project, 'AGENTS.md')));
  assert.equal(jsonCli('install.mjs', ['--project', toolkit]).report.error.code, 'INSTALL');
});

test('an empty repository defers its checks to a new application, and needs one commit', async t => {
  const project = await fixture(t, null);
  git(project, 'init', '-b', 'main');
  assert.match(jsonCli('install.mjs', ['--project', project]).report.error.message, /git commit --allow-empty/);
  await writeFile(resolve(project, 'README.md'), '# Habits\n');
  await mkdir(resolve(project, 'docs'));
  await writeFile(resolve(project, 'docs/idea.md'), 'An app for habits.');
  commit(project, 'initial');
  const install = jsonCli('install.mjs', ['--project', project], { env: { ...process.env, PATH: `/usr/bin:${dirname(process.execPath)}` } }).report;
  assert.deepEqual([install.status, install.checks, install.instructionWorkflow], ['PASS', [], 'skipped: empty project; install again after the app\'s first milestone']);
  await assert.rejects(readFile(resolve(project, '.project-os/engineering.config.json')), 'nothing is invented');
  assert.equal(run(project, 'setup').config, 'deferred');
  await writeFile(resolve(project, 'main.py'), 'print(1)\n');
  assert.equal(run(project, 'setup').error.code, 'SETUP', 'product code without a test command is not empty');
});
