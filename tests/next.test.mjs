import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { check, config, fixture, git, jsonCli, repository, saveConfig } from './helpers.mjs';
import { parsePlan, planDigest } from '../scripts/lib/next.mjs';
import { decisionGate, decisionGroups, designRequested, readState } from '../scripts/lib/run-state.mjs';

const cliRun = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]).report;
// The user's decision commands leave a grant; the CLI records one outside Claude Code.
function decide(project, action, option, target, name) {
  cliRun(project, 'grant', ['--action', action, '--target', target, '--run', name]);
  return cliRun(project, action, ['--run', name, option, target]);
}
const next = (project, name, extra = []) => cliRun(project, 'next', ['--run', name, ...extra]);
const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fingerprint = project => cliRun(project, 'fingerprint').codeState;
const agentsOf = action => action.agents.map(entry => entry.agent);
async function report(dir, name, fields) {
  await writeFile(resolve(dir, `pending-eval-${name}.json`), JSON.stringify({ schemaVersion: 1, mode: 'full', criteria: [], findings: [], notAssessed: [], ...fields }));
}
const finding = (problem = 'AC-1 has no test') => ({ id: 'F1', severity: 'high', problem, impact: 'regressions go unnoticed', fix: 'add a test' });
async function start(t, { tier, type = 'feature', checks = [check()] }) {
  const project = await repository(t);
  await saveConfig(project, config(checks));
  const { run: name, directory: dir } = cliRun(project, 'init', ['--name', 'export', '--type', type, '--tier', tier]);
  return { project, name, dir };
}
// Spec and plan through their evaluations; returns the plan gate action of a standard run.
async function plan(project, name, dir, steps = '### S1 — export\n- Covers: AC-1\n\n### S2 — docs\n- Covers: AC-2\n') {
  await writeFile(resolve(dir, 'idea.md'), 'Add CSV export.');
  assert.equal(agentsOf(next(project, name)).join(), 'peos:spec-writer');
  await writeFile(resolve(dir, 'spec.md'), '# Export\n- AC-1: x\n- AC-2: y\n');
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  const planner = next(project, name);
  assert.equal(agentsOf(planner).join(), 'peos:planner');
  assert.ok(planner.applied.includes('code map'));
  await writeFile(resolve(dir, 'plan.md'), `# Plan\n\n## Steps\n\n${steps}`);
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  return next(project, name);
}

test('parsePlan reads steps, covered criteria and milestones', () => {
  const parsed = parsePlan('## Milestones\n- M1: skeleton — steps: S1\n- M2: export — steps: S2, S3\n\n## Steps\n\n### S1 — a\n- Covers: AC-1, AC-2\n\n### S2 — b\n- Covers: AC-3\n\n### S3 — c\n');
  assert.deepEqual(parsed.steps, ['S1', 'S2', 'S3']);
  assert.deepEqual(parsed.covers, { S1: ['AC-1', 'AC-2'], S2: ['AC-3'], S3: [] });
  assert.deepEqual(parsed.milestones, [{ id: 'M1', steps: ['S1'] }, { id: 'M2', steps: ['S2', 'S3'] }]);
  assert.deepEqual(parsePlan('## Plan\n- S1: change — files: a — covers: AC-1 — test: t\n', { task: true }).steps, ['S1']);
});

test('a small run goes from task.md through implementer, checks and evaluation to the summary', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  const write = next(project, name);
  assert.equal(write.do, 'write');
  assert.equal(write.artifact, resolve(dir, 'task.md'));
  await writeFile(resolve(dir, 'task.md'), '# Export\n## Acceptance criteria\n- AC-1: x\n## Plan\n- S1: export — files: a — covers: AC-1 — test: t\n');
  const implement = next(project, name);
  assert.equal(implement.do, 'spawn');
  assert.deepEqual(agentsOf(implement), ['peos:implementer']);
  assert.deepEqual(implement.agents[0].inputs.steps, ['S1']);
  assert.match(implement.then, /--done/);
  assert.ok(implement.applied.includes('stage implement'));
  assert.doesNotMatch(await readFile(implement.agents[0].inputs['code map'], 'utf8'), /toCsv/);
  await writeFile(resolve(project, 'base.txt'), 'exported\n');
  await writeFile(resolve(project, 'export.js'), 'export function toCsv() {}\n');
  const finish = next(project, name, ['--done', 'S1']);
  assert.deepEqual([finish.do, finish.command], ['run', 'finish']);
  assert.equal(cliRun(project, 'finish', finish.args).stage, 'evaluate');
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate), ['peos:eval-code']);
  assert.equal(evaluate.agents[0].model, 'sonnet');
  assert.equal(evaluate.agents[0].inputs.focus, 'all');
  assert.equal(evaluate.agents[0].inputs.subject, fingerprint(project));
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  const summary = next(project, name);
  assert.deepEqual([summary.do, summary.stage], ['write', 'release']);
  assert.ok(summary.applied.includes('recorded code-all'));
  await writeFile(resolve(dir, 'summary.md'), '# Export\n');
  assert.equal(next(project, name).do, 'finished');
});

test('a standard run evaluates spec and plan, then asks for one decision before implementing', async t => {
  const { project, name } = await start(t, { tier: 'standard' });
  const gate = await plan(project, name, resolve(project, '.project-os/runs', cliRun(project, 'status').runs[0].run));
  assert.equal(gate.do, 'gate');
  assert.deepEqual(gate.gates, ['spec', 'plan']);
  assert.equal(decide(project, 'approve', '--gate', 'plan', name).status, 'PASS');
  const implement = next(project, name);
  assert.deepEqual(implement.agents[0].inputs.steps, ['S1', 'S2']);
});

test('a failed evaluation goes back to the producer, then to the evaluator with its findings, and a plateau stops', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'idea.md'), 'Add CSV export.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), 'spec v1');
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'FAIL', subject: sha('spec v1'), findings: [finding()] });
  const revise = next(project, name);
  assert.deepEqual(agentsOf(revise), ['peos:spec-writer']);
  assert.equal(revise.agents[0].inputs.findings[0].problem, 'AC-1 has no test');
  await writeFile(resolve(dir, 'spec.md'), 'spec v2');
  const again = next(project, name);
  assert.deepEqual(agentsOf(again), ['peos:eval-spec']);
  assert.equal(again.agents[0].inputs['previous blocking findings'].length, 1);
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'FAIL', subject: sha('spec v2'), findings: [finding()] });
  const stop = next(project, name);
  assert.deepEqual([stop.do, stop.key, stop.plateau], ['limit', 'spec', true]);
  assert.match(stop.message, /\/peos:retry spec/);
  // The plateau holds in a later session until the user decides.
  assert.equal(next(project, name).do, 'limit');
  // After /peos:retry the producer works on the cleared findings; the evaluator then sees them.
  decide(project, 'reset-eval', '--key', 'spec', name);
  const retry = next(project, name);
  assert.deepEqual(agentsOf(retry), ['peos:spec-writer']);
  assert.equal(retry.agents[0].inputs.findings.length, 1);
  await writeFile(resolve(dir, 'spec.md'), 'spec v3');
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate), ['peos:eval-spec']);
  assert.equal(evaluate.agents[0].inputs['previous blocking findings'].length, 1);
});

test('a rejected report is retried once with its error, a second rejection stops', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'spec.md'), 'spec');
  next(project, name);
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: sha('other') });
  const retry = next(project, name);
  assert.deepEqual(agentsOf(retry), ['peos:eval-spec']);
  assert.match(retry.agents[0].inputs['previous report rejected'], /^STALE/);
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: sha('other') });
  assert.deepEqual([next(project, name).do, next(project, name).do], ['stop', 'spawn']);
});

test('a revision request sends the producer back to work, not the evaluator to the old artifact', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await plan(project, name, dir);
  decide(project, 'revise', '--gate', 'plan', name);
  const revise = next(project, name);
  assert.deepEqual(agentsOf(revise), ['peos:planner']);
  assert.match(revise.agents[0].inputs.revision, /feedback/);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n### S1 — export\n- Covers: AC-1, AC-2\n');
  assert.deepEqual(agentsOf(next(project, name)), ['peos:eval-plan']);
});

test('failing checks go to the implementer and the third failed run stops', async t => {
  const { project, name, dir } = await start(t, { tier: 'small', checks: [check('test', 'process.exit(1)')] });
  await writeFile(resolve(dir, 'task.md'), '# T\n## Plan\n- S1: x — files: a — covers: AC-1 — test: t\n');
  next(project, name);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await writeFile(resolve(project, 'base.txt'), `attempt ${attempt}\n`);
    const finish = next(project, name, attempt === 1 ? ['--done', 'S1'] : []);
    assert.equal(finish.command, 'finish');
    cliRun(project, 'finish', finish.args);
    const after = next(project, name);
    if (attempt < 3) assert.deepEqual(after.agents[0].inputs['failed checks'], ['test']);
    else assert.deepEqual([after.do, after.code], ['stop', 'CHECKS']);
  }
});

test('code findings go to the implementer, and after /peos:retry the cleared findings do too', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  await writeFile(resolve(dir, 'task.md'), '# T\n## Plan\n- S1: x — files: a — covers: AC-1 — test: t\n');
  next(project, name);
  for (let round = 1; round <= 3; round++) {
    await writeFile(resolve(project, 'base.txt'), `round ${round}\n`);
    cliRun(project, 'finish', next(project, name, round === 1 ? ['--done', 'S1'] : []).args);
    assert.deepEqual(agentsOf(next(project, name)), ['peos:eval-code']);
    await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'FAIL', subject: fingerprint(project), findings: [finding(`round ${round} breaks AC-1`)] });
    const after = next(project, name);
    if (round < 3) assert.equal(after.agents[0].inputs.findings[0].problem, `round ${round} breaks AC-1`);
    else assert.deepEqual([after.do, after.key, after.round], ['limit', 'code-all', 3]);
  }
  decide(project, 'reset-eval', '--key', 'code-all', name);
  const retry = next(project, name);
  assert.equal(retry.do, 'spawn', JSON.stringify(retry));
  assert.deepEqual(agentsOf(retry), ['peos:implementer']);
  assert.equal(retry.agents[0].inputs.findings[0].problem, 'round 3 breaks AC-1');
  // An evidence round re-judges the unchanged code instead of sending the implementer.
  await writeFile(resolve(project, 'base.txt'), 'round 4\n');
  cliRun(project, 'finish', next(project, name).args);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'FAIL', subject: fingerprint(project), findings: [finding('no recorded evidence for AC-1')] });
  const evidence = next(project, name, ['--evidence-round']);
  assert.deepEqual(agentsOf(evidence), ['peos:eval-code']);
  assert.match(evidence.agents[0].inputs['evidence round'], /did not change/);
});

test('a refactor records its baseline before the implementer', async t => {
  const { project, name, dir } = await start(t, { tier: 'small', type: 'refactor' });
  await writeFile(resolve(dir, 'task.md'), '# T\n## Plan\n- S1: x — files: a — covers: AC-1 — test: t\n');
  const baseline = next(project, name);
  assert.deepEqual([baseline.do, baseline.command], ['run', 'record-baseline']);
  cliRun(project, 'record-baseline', baseline.args);
  assert.deepEqual(agentsOf(next(project, name)), ['peos:implementer']);
});

test('a large run decides its direction once, then its plan, then implements, checks and evaluates milestone by milestone', async t => {
  const { project, name, dir } = await start(t, { tier: 'large' });
  await writeFile(resolve(dir, 'idea.md'), 'Reports app.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), '# Spec\n- AC-1: a\n- AC-2: b\n');
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  // The spec passes on its PASS: the direction is decided once, with the architecture.
  const architect = next(project, name);
  assert.deepEqual(agentsOf(architect), ['peos:architect']);
  await writeFile(resolve(dir, 'architecture.md'), '# Architecture\n');
  const architectureEval = next(project, name);
  assert.deepEqual(agentsOf(architectureEval), ['peos:eval-plan']);
  assert.equal(architectureEval.agents[0].inputs.focus, 'architecture');
  assert.match(architectureEval.agents[0].inputs.report, /pending-eval-plan-architecture\.json$/);
  await report(dir, 'plan-architecture', { evaluator: 'plan', focus: 'architecture', verdict: 'PASS', subject: architectureEval.agents[0].inputs.subject });
  const direction = next(project, name);
  assert.deepEqual([direction.do, direction.gates], ['gate', ['spec', 'architecture']]);
  assert.match(direction.message, /^Approve with \/peos:approve, or request changes with \/peos:revise <spec\|architecture> <feedback>\. Approving also consents to installing the dependencies/);
  // The planner does not start on an undecided direction.
  assert.equal(cliRun(project, 'advance', ['--run', name, '--to', 'plan']).error.code, 'GATE');
  const approved = decide(project, 'approve', '--gate', 'architecture', name);
  assert.deepEqual([approved.gates.spec.status, approved.gates.architecture.status, approved.gates.plan.status], ['approved', 'approved', 'pending']);
  const planner = next(project, name);
  assert.equal(planner.agents[0].inputs.architecture, resolve(dir, 'architecture.md'));
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n## Milestones\n- M1: skeleton — steps: S1\n- M2: export — steps: S2\n\n## Steps\n\n### S1 — skeleton\n- Covers: AC-1\n\n### S2 — export\n- Covers: AC-2\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  assert.deepEqual(next(project, name).gates, ['plan']);
  decide(project, 'approve', '--gate', 'plan', name);
  const first = next(project, name);
  assert.deepEqual([first.agents[0].inputs.steps, first.agents[0].inputs.milestone], [['S1'], 'M1']);
  assert.match(first.agents[0].inputs.dependencies, /approved architecture/);
  await writeFile(resolve(project, 'base.txt'), 'skeleton\n');
  // The first milestone is most of the change, so the second one is worth a delta evaluation.
  await writeFile(resolve(project, 'skeleton.js'), `export function startServer() {}\n${'// skeleton\n'.repeat(40)}`);
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  const evaluate = next(project, name);
  assert.deepEqual(evaluate.agents.map(entry => entry.inputs.focus), ['acceptance', 'quality', 'tests']);
  assert.ok(evaluate.agents.every(entry => !entry.model));
  assert.deepEqual(evaluate.agents[0].inputs['criteria in scope'], ['AC-1']);
  for (const focus of ['acceptance', 'quality', 'tests']) await report(dir, `code-${focus}`, { evaluator: 'code', focus, verdict: 'PASS', subject: fingerprint(project) });
  const second = next(project, name);
  assert.ok(second.applied.includes('milestone M1 done'));
  assert.deepEqual([second.stage, second.agents[0].inputs.steps], ['implement', ['S2']]);
  assert.ok(second.applied.includes('code map'), 'names M1 added reach the next implementer');
  assert.match(await readFile(second.agents[0].inputs['code map'], 'utf8'), /skeleton\.js\(startServer\)/);
  await writeFile(resolve(project, 'base.txt'), 'export\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S2']).args);
  const last = next(project, name);
  assert.equal(last.agents[0].inputs['criteria in scope'], undefined, 'the last milestone judges every criterion');
  // M1's passed evaluations are bases: quality and tests judge only M2's change, acceptance judges everything.
  assert.deepEqual(last.agents.map(entry => [entry.inputs.focus, Boolean(entry.inputs.basis)]), [['acceptance', false], ['quality', true], ['tests', true]]);
  assert.match(await readFile(last.agents[1].inputs['delta diff'], 'utf8'), /^\+export$/m);
  assert.doesNotMatch(await readFile(last.agents[1].inputs['delta diff'], 'utf8'), /startServer/);
  assert.equal(last.agents[1].inputs['previous report'], resolve(dir, 'evals/code-quality.base.json'));
  for (const focus of ['acceptance', 'quality', 'tests']) await report(dir, `code-${focus}`, { evaluator: 'code', focus, verdict: 'PASS', subject: fingerprint(project) });
  const summary = next(project, name);
  assert.deepEqual([summary.do, summary.stage], ['write', 'release'], summary.message);
  assert.deepEqual(JSON.parse(await readFile(resolve(dir, 'state.json'))).milestones, { M1: 'done', M2: 'done' });
});

test('an app starts in an empty repository and binds the checks its walking skeleton declares', async t => {
  const project = await fixture(t, null);
  git(project, 'init', '-b', 'main');
  await writeFile(resolve(project, 'README.md'), '# Habits\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'initial');
  assert.equal(cliRun(project, 'setup').config, 'deferred');
  const { run: name, directory: dir } = cliRun(project, 'init', ['--name', 'habits', '--type', 'app', '--tier', 'large']);
  for (const [gate, file, evaluator, focus] of [['spec', 'spec.md', 'spec'], ['architecture', 'architecture.md', 'plan', 'architecture'], ['plan', 'plan.md', 'plan']]) {
    next(project, name);
    await writeFile(resolve(dir, file), gate === 'plan' ? '# Plan\n## Milestones\n- M1: skeleton — steps: S1\n\n### S1 — skeleton\n- Covers: AC-1\n' : `# ${gate}\n- AC-1: a\n`);
    const subject = next(project, name).agents[0].inputs.subject;
    await report(dir, focus ? `${evaluator}-${focus}` : evaluator, { evaluator, ...(focus ? { focus } : {}), verdict: 'PASS', subject });
    if (gate === 'spec') continue;
    assert.equal(next(project, name).do, 'gate');
    decide(project, 'approve', '--gate', gate, name);
  }
  const skeleton = next(project, name);
  assert.deepEqual(skeleton.agents[0].inputs.steps, ['S1']);
  assert.match(skeleton.agents[0].inputs.checks[0], /none yet/);
  assert.equal(JSON.parse(await readFile(resolve(dir, 'state.json'))).bootstrap, true);
  // The walking skeleton declares its test command; the configuration is derived from it.
  await writeFile(resolve(project, 'package.json'), JSON.stringify({ name: 'habits', scripts: { test: 'node -e ""' } }));
  await writeFile(resolve(project, '.gitignore'), 'node_modules/\n');
  const finish = next(project, name, ['--done', 'S1']);
  assert.ok(finish.applied.includes('configuration derived from the new manifests'));
  assert.equal(finish.command, 'finish');
  assert.equal(cliRun(project, 'finish', finish.args).checks, 'PASS');
  assert.match(JSON.parse(await readFile(resolve(dir, 'state.json'))).configHash, /^sha256:/);
  const profiler = next(project, name);
  assert.deepEqual(agentsOf(profiler), ['peos:profiler']);
  assert.match(profiler.agents[0].inputs['AGENTS.md'], /missing/);
});

test('a run that is not an app stops without a configuration, and an empty project is not one to set up', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  await writeFile(resolve(dir, 'task.md'), '# T\n## Plan\n- S1: x\n');
  await unlink(resolve(project, '.project-os/engineering.config.json'));
  const stop = next(project, name);
  assert.deepEqual([stop.do, stop.code], ['stop', 'CONFIG_MISSING']);
  assert.equal(jsonCli('peos-run.mjs', ['setup', '--project', project]).report.error.code, 'SETUP', 'base.txt is product content');
});

test('review regressions: BLOCKED gates, stale round limits, re-approved plans and code changed after release', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'idea.md'), 'Add CSV export.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), 'spec');
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'BLOCKED', mode: 'degraded', subject: sha('spec'), notAssessed: ['the export format'] });
  const blocked = next(project, name);
  assert.deepEqual([blocked.do, blocked.notAssessed], ['blocked', ['the export format']]);
  // The third failed round holds after the work changed by hand, until the user retries.
  for (const [round, text] of [[2, 'spec 2'], [3, 'spec 3']]) {
    await writeFile(resolve(dir, 'spec.md'), text);
    next(project, name);
    await report(dir, 'spec', { evaluator: 'spec', verdict: 'FAIL', subject: sha(text), findings: [finding(`problem ${round}`)] });
    assert.equal(next(project, name).do, round < 3 ? 'spawn' : 'limit');
  }
  await writeFile(resolve(dir, 'spec.md'), 'spec by hand');
  const held = next(project, name);
  assert.deepEqual([held.do, held.round], ['limit', 3], JSON.stringify(held));
  decide(project, 'reset-eval', '--key', 'spec', name);
  assert.deepEqual(agentsOf(next(project, name)), ['peos:eval-spec'], 'the changed spec is evaluated, not sent back');
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: sha('spec by hand') });
  next(project, name);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n### S1 — export\n- Covers: AC-1\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  next(project, name);
  decide(project, 'approve', '--gate', 'plan', name);
  next(project, name);
  await writeFile(resolve(project, 'base.txt'), 'export\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  next(project, name);
  await writeFile(resolve(dir, 'summary.md'), '# Export\n');
  assert.equal(next(project, name).do, 'finished');
  // Code edited after the release stage: checks and evaluation run again, the summary goes.
  await writeFile(resolve(project, 'base.txt'), 'edited after release\n');
  const again = next(project, name);
  assert.deepEqual([again.do, again.command], ['run', 'finish']);
  assert.ok(again.applied.includes('code changed after release: checks again'));
  await assert.rejects(readFile(resolve(dir, 'summary.md')));
  // A revised and re-approved plan starts again from its first step.
  decide(project, 'revise', '--gate', 'plan', name);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n### S1 — export, differently\n- Covers: AC-1\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  next(project, name);
  decide(project, 'approve', '--gate', 'plan', name);
  const restart = next(project, name);
  assert.deepEqual(restart.agents[0].inputs.steps, ['S1']);
  const state = JSON.parse(await readFile(resolve(dir, 'state.json')));
  assert.equal(state.evals['code-all'], undefined);
});

test('review regressions: a scoped milestone PASS is not reused, and unstable checks stop', async t => {
  const { project, name, dir } = await start(t, { tier: 'large' });
  for (const [gate, file, evaluator, focus] of [['spec', 'spec.md', 'spec'], ['architecture', 'architecture.md', 'plan', 'architecture'], ['plan', 'plan.md', 'plan']]) {
    next(project, name);
    await writeFile(resolve(dir, file), gate === 'plan' ? '## Milestones\n- M1: a — steps: S1\n- M2: b — steps: S2\n\n### S1 — a\n- Covers: AC-1\n\n### S2 — b\n- Covers: AC-2\n' : `# ${gate}\n`);
    await report(dir, focus ? `${evaluator}-${focus}` : evaluator, { evaluator, ...(focus ? { focus } : {}), verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
    next(project, name);
    decide(project, 'approve', '--gate', gate, name);
  }
  next(project, name);
  await writeFile(resolve(project, 'base.txt'), 'both milestones at once\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  for (const focus of ['acceptance', 'quality', 'tests']) await report(dir, `code-${focus}`, { evaluator: 'code', focus, verdict: 'PASS', subject: fingerprint(project) });
  next(project, name);
  // M2 changes nothing: M1's scoped reports are not carried; every focus runs in full,
  // judging every criterion.
  const evaluate = next(project, name, ['--done', 'S2']);
  assert.deepEqual(evaluate.agents.map(entry => [entry.inputs.focus, entry.inputs.basis]), [['acceptance', undefined], ['quality', undefined], ['tests', undefined]]);
  assert.equal(evaluate.agents[0].inputs['criteria in scope'], undefined);
  assert.equal(cliRun(project, 'carry-eval', ['--run', name, '--key', 'code-tests']).error.code, 'CARRY', 'a scoped base is never carried');
  // A check that writes files Git sees cannot bind evidence: the run stops instead of looping.
  await writeFile(resolve(project, '.project-os/engineering.config.json'), JSON.stringify(config([check('test', "require('fs').writeFileSync('coverage.txt', String(Date.now()))")])));
  const { project: other, name: small, dir: smallDir } = await start(t, { tier: 'small', checks: [check('test', "require('fs').writeFileSync('coverage.txt', String(Date.now()))")] });
  await writeFile(resolve(smallDir, 'task.md'), '# T\n## Plan\n- S1: x\n');
  next(other, small);
  cliRun(other, 'finish', next(other, small, ['--done', 'S1']).args);
  const unstable = next(other, small);
  assert.deepEqual([unstable.do, unstable.code], ['stop', 'UNSTABLE']);
});

test('review regressions: an app outside an empty repository needs its configuration first', async t => {
  const project = await repository(t);
  const { run: name, directory: dir } = cliRun(project, 'init', ['--name', 'second', '--type', 'app', '--tier', 'large']);
  for (const [gate, file, evaluator, focus] of [['spec', 'spec.md', 'spec'], ['architecture', 'architecture.md', 'plan', 'architecture'], ['plan', 'plan.md', 'plan']]) {
    next(project, name);
    await writeFile(resolve(dir, file), gate === 'plan' ? '### S1 — a\n- Covers: AC-1\n' : `# ${gate}\n`);
    await report(dir, focus ? `${evaluator}-${focus}` : evaluator, { evaluator, ...(focus ? { focus } : {}), verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
    next(project, name);
    decide(project, 'approve', '--gate', gate, name);
  }
  const stop = next(project, name);
  assert.deepEqual([stop.do, stop.code], ['stop', 'CONFIG_MISSING']);
});

test('after a fix the evaluator judges only the change since its report', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  await writeFile(resolve(dir, 'task.md'), '# T\n## Plan\n- S1: x — files: a — covers: AC-1 — test: t\n');
  next(project, name);
  await writeFile(resolve(project, 'export.js'), Array.from({ length: 40 }, (_, i) => `export const column${i} = ${i};`).join('\n') + '\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  assert.equal(next(project, name).agents[0].inputs.basis, undefined, 'the first evaluation is full');
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'FAIL', subject: fingerprint(project), findings: [finding()] });
  next(project, name);
  await writeFile(resolve(project, 'export.test.js'), 'it("has columns", () => expect(1).toBe(1));\n');
  cliRun(project, 'finish', next(project, name).args);
  const again = next(project, name);
  assert.deepEqual(agentsOf(again), ['peos:eval-code']);
  assert.match(again.agents[0].inputs.basis, /^delta/);
  assert.equal(again.agents[0].inputs['previous report'], resolve(dir, 'evals/code-all.json'));
  assert.equal(again.agents[0].inputs['previous blocking findings'][0].problem, 'AC-1 has no test');
  const delta = await readFile(again.agents[0].inputs['delta diff'], 'utf8');
  assert.match(delta, /export\.test\.js/);
  assert.doesNotMatch(delta, /column1/);
});

test('re-approving a plan keeps unchanged steps done and reworks only the changed ones', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await plan(project, name, dir);
  decide(project, 'approve', '--gate', 'plan', name);
  next(project, name);
  await writeFile(resolve(project, 'export.js'), Array.from({ length: 40 }, (_, i) => `export const column${i} = ${i};`).join('\n') + '\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1,S2']).args);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  assert.equal(next(project, name).do, 'write');
  // The user revises the plan: S2 changes, S1 stays as it was.
  decide(project, 'revise', '--gate', 'plan', name);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n## Steps\n\n### S1 — export\n- Covers: AC-1\n\n### S2 — docs and a changelog\n- Covers: AC-2\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  assert.equal(next(project, name).do, 'gate');
  decide(project, 'approve', '--gate', 'plan', name);
  const state = JSON.parse(await readFile(resolve(dir, 'state.json')));
  assert.deepEqual(state.steps, { S1: 'done' });
  assert.deepEqual(Object.keys(state.evalBases), ['code-all']);
  const rework = next(project, name);
  assert.deepEqual(rework.agents[0].inputs.steps, ['S2']);
  await writeFile(resolve(project, 'CHANGELOG.md'), '- CSV export\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S2']).args);
  // code-all judges the acceptance criteria: after a re-approval it runs in full.
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate), ['peos:eval-code']);
  assert.equal(evaluate.agents[0].inputs.basis, undefined);
});

test('a step digest covers its whole criteria and the architecture', () => {
  const plan = '## Steps\n### S1 — limit\n- Covers: AC-1\n\n### S2 — docs\n- Covers: AC-2\n';
  const spec = limit => `## Acceptance criteria\n- AC-1: Requests are limited\n  to ${limit} per minute.\n- AC-2: Docs exist.\n\n## Decisions\n`;
  const before = planDigest(plan, spec(5), '# Architecture A\n');
  const wider = planDigest(plan, spec(500), '# Architecture A\n');
  assert.notEqual(before.steps.S1, wider.steps.S1, 'a continuation line is part of the criterion');
  assert.equal(before.steps.S2, wider.steps.S2);
  assert.notEqual(before.steps.S2, planDigest(plan, spec(5), '# Architecture B\n').steps.S2);
});

const uiSpec = (design = 'new') => `# Spec\n\n## User interface\n<!-- Design: new -->\nDesign: ${design}\n| Screen | States |\n| Home | loading, empty |\n\n## Acceptance criteria\n- AC-1: a\n- AC-2: b\n`;

test('one approval decides a group of gates: everything on standard, direction then plan on large', () => {
  const state = (tier, gates) => ({ tier, gates: Object.fromEntries(gates.map(([name, status]) => [name, { status }])) });
  assert.deepEqual(decisionGroups(state('standard', [['spec', 'pending'], ['design', 'pending'], ['plan', 'pending']])), [['spec', 'design', 'plan']]);
  assert.deepEqual(decisionGroups(state('large', [['spec', 'pending'], ['architecture', 'pending'], ['design', 'pending'], ['plan', 'pending']])), [['spec', 'architecture', 'design'], ['plan']]);
  assert.equal(decisionGate(state('standard', [['spec', 'pending'], ['plan', 'pending']])), 'plan');
  assert.equal(decisionGate(state('large', [['spec', 'pending'], ['architecture', 'pending'], ['plan', 'pending']])), 'architecture');
  assert.equal(decisionGate(state('large', [['spec', 'pending'], ['architecture', 'pending'], ['design', 'pending'], ['plan', 'pending']])), 'design');
  assert.equal(decisionGate(state('large', [['spec', 'approved'], ['architecture', 'approved'], ['plan', 'pending']])), 'plan');
  // A revised spec reopens the direction, not only the plan.
  assert.equal(decisionGate(state('large', [['spec', 'revision_requested'], ['architecture', 'pending'], ['plan', 'pending']])), 'architecture');
  assert.equal(decisionGate(state('small', [])), undefined);
  assert.equal(decisionGate(state('large', [['spec', 'approved'], ['architecture', 'approved'], ['plan', 'approved']])), undefined);
});

test('a spec asks for a design only with Design: new in its User interface section', () => {
  assert.equal(designRequested(uiSpec()), true);
  assert.equal(designRequested(uiSpec('existing')), false);
  assert.equal(designRequested('# Spec\n\n## User interface\n<!-- Design: new -->\n\n## Goal\nDesign: new\n'), false, 'comments and other sections do not count');
  assert.equal(designRequested(null), false);
  for (const line of ['`Design: new`', '**Design:** new', 'Design: `new`', '- **Design**: new', '| Design: new |']) assert.equal(designRequested(`## User interface\n${line}\n`), true, line);
});

test('a large run with new screens decides spec, architecture and design at once, and builds from the design', async t => {
  const { project, name, dir } = await start(t, { tier: 'large' });
  await writeFile(resolve(dir, 'idea.md'), 'Reports app.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), uiSpec());
  const specEval = next(project, name);
  assert.ok(specEval.applied.includes('design gate added'));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(resolve(dir, 'state.json'))).gates), ['spec', 'architecture', 'design', 'plan']);
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: specEval.agents[0].inputs.subject });
  assert.deepEqual(agentsOf(next(project, name)), ['peos:architect']);
  await writeFile(resolve(dir, 'architecture.md'), '# Architecture\n');
  await report(dir, 'plan-architecture', { evaluator: 'plan', focus: 'architecture', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  const designer = next(project, name);
  assert.deepEqual([designer.stage, agentsOf(designer).join()], ['design', 'peos:designer']);
  assert.deepEqual([designer.agents[0].inputs.output, designer.agents[0].inputs.preview, designer.agents[0].inputs.architecture],
    [resolve(dir, 'design.md'), resolve(dir, 'design-preview.html'), resolve(dir, 'architecture.md')]);
  assert.match(designer.agents[0].inputs.template, /templates\/run\/design\.md$/);
  await writeFile(resolve(dir, 'design.md'), '# Design\n');
  await writeFile(resolve(dir, 'design-preview.html'), '<p>preview</p>');
  const designEval = next(project, name);
  assert.deepEqual([agentsOf(designEval).join(), designEval.agents[0].inputs.focus], ['peos:eval-design', undefined]);
  assert.match(designEval.agents[0].inputs.report, /pending-eval-design\.json$/);
  // peos-run serves the preview file, so the evaluator judges the design as rendered.
  const served = await fetch(designEval.agents[0].inputs['preview url']);
  assert.deepEqual([served.status, await served.text()], [200, '<p>preview</p>']);
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${designEval.agents[0].inputs['preview url']}/state.json`)).status, 404);
  // What a browser tool leaves in the project while an evaluator looks is not a code change.
  const untouched = fingerprint(project);
  await mkdir(resolve(project, '.playwright-mcp'));
  await writeFile(resolve(project, '.playwright-mcp/page.png'), 'screenshot');
  assert.equal(fingerprint(project), untouched);
  assert.equal(git(project, 'status', '--porcelain', '--', '.playwright-mcp'), '');
  await report(dir, 'design', { evaluator: 'design', verdict: 'PASS', subject: designEval.agents[0].inputs.subject });
  const gate = next(project, name);
  assert.deepEqual(gate.gates, ['spec', 'architecture', 'design'], 'one decision covers the direction');
  assert.ok(gate.artifacts.includes(resolve(dir, 'design-preview.html')));
  assert.match(gate.message, /design-preview\.html/);
  assert.ok(Object.values(decide(project, 'approve', '--gate', 'design', name).gates).slice(0, 3).every(entry => entry.status === 'approved'));
  await assert.rejects(fetch(designEval.agents[0].inputs['preview url']), 'the decided design is no longer served');
  const planner = next(project, name);
  assert.equal(planner.agents[0].inputs.design, resolve(dir, 'design.md'));
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n## Milestones\n- M1: all — steps: S1\n\n## Steps\n\n### S1 — theme\n- Covers: AC-1, AC-2\n');
  const planEval = next(project, name);
  assert.equal(planEval.agents[0].inputs.design, resolve(dir, 'design.md'));
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: planEval.agents[0].inputs.subject });
  next(project, name);
  decide(project, 'approve', '--gate', 'plan', name);
  const implement = next(project, name);
  assert.equal(implement.agents[0].inputs.design, resolve(dir, 'design.md'));
  // Approved designs stay even when nothing else changes.
  assert.equal(JSON.parse(await readFile(resolve(dir, 'state.json'))).gates.design.status, 'approved');
});

test('a standard run passes its design on a PASS and decides spec, design and plan at once; Design: existing has no gate', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'idea.md'), 'Add a reports screen.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), uiSpec());
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  const designer = next(project, name);
  assert.deepEqual(agentsOf(designer), ['peos:designer']);
  assert.equal(designer.agents[0].inputs.architecture, undefined);
  await writeFile(resolve(dir, 'design.md'), '# Design\n');
  await report(dir, 'design', { evaluator: 'design', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  assert.deepEqual(agentsOf(next(project, name)), ['peos:planner']);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n## Steps\n\n### S1 — screen\n- Covers: AC-1, AC-2\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  const gate = next(project, name);
  assert.deepEqual(gate.gates, ['spec', 'design', 'plan']);
  assert.match(gate.message, /<spec\|design\|plan>/);
  const approved = decide(project, 'approve', '--gate', 'plan', name);
  assert.deepEqual(Object.values(approved.gates).map(entry => entry.status), ['approved', 'approved', 'approved']);
  assert.equal(next(project, name).agents[0].inputs.design, resolve(dir, 'design.md'));

  const other = await start(t, { tier: 'standard' });
  await writeFile(resolve(other.dir, 'idea.md'), 'Rename a button.');
  next(other.project, other.name);
  await writeFile(resolve(other.dir, 'spec.md'), uiSpec('existing'));
  assert.deepEqual(agentsOf(next(other.project, other.name)), ['peos:eval-spec']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(resolve(other.dir, 'state.json'))).gates), ['spec', 'plan']);
});

test('a revised spec without Design: new removes an unapproved design gate; small runs never get one', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'idea.md'), 'Add a reports screen.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), uiSpec());
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  assert.deepEqual(agentsOf(next(project, name)), ['peos:designer']);
  await writeFile(resolve(dir, 'spec.md'), uiSpec('existing'));
  const after = next(project, name);
  assert.ok(after.applied.includes('design gate removed'));
  assert.deepEqual(agentsOf(after), ['peos:eval-spec']);
  assert.equal(JSON.parse(await readFile(resolve(dir, 'state.json'))).gates.design, undefined);

  const small = await start(t, { tier: 'small' });
  await writeFile(resolve(small.dir, 'spec.md'), uiSpec());
  await writeFile(resolve(small.dir, 'task.md'), '# T\n## Plan\n- S1: x — files: a — covers: AC-1 — test: t\n');
  assert.deepEqual(agentsOf(next(small.project, small.name)), ['peos:implementer']);
  assert.deepEqual(JSON.parse(await readFile(resolve(small.dir, 'state.json'))).gates, {});
});

test('a changed design changes every step digest', () => {
  const plan = '## Steps\n\n### S1 — a\n- Covers: AC-1\n';
  const spec = '- AC-1: a\n';
  assert.notEqual(planDigest(plan, spec, 'arch\0design v1').steps.S1, planDigest(plan, spec, 'arch\0design v2').steps.S1);
});

test('the preview is part of the design, and changed upstream artifacts invalidate later evaluations', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  await writeFile(resolve(dir, 'idea.md'), 'Add a reports screen.');
  next(project, name);
  await writeFile(resolve(dir, 'spec.md'), uiSpec());
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  next(project, name);
  await writeFile(resolve(dir, 'design.md'), '# Design\n');
  await writeFile(resolve(dir, 'design-preview.html'), '<link href="https://fonts.example/x.css">');
  const first = next(project, name);
  await report(dir, 'design', { evaluator: 'design', verdict: 'FAIL', subject: first.agents[0].inputs.subject, findings: [finding('the preview loads a web font')] });
  assert.deepEqual(agentsOf(next(project, name)), ['peos:designer']);
  // A fix to the preview alone is a new design for the evaluator.
  await writeFile(resolve(dir, 'design-preview.html'), '<p>preview</p>');
  const again = next(project, name);
  assert.deepEqual(agentsOf(again), ['peos:eval-design']);
  assert.equal(again.agents[0].inputs['preview url'], first.agents[0].inputs['preview url'], 'the running server is reused and serves the new file');
  assert.equal(await (await fetch(again.agents[0].inputs['preview url'])).text(), '<p>preview</p>');
  assert.notEqual(again.agents[0].inputs.subject, first.agents[0].inputs.subject);
  await report(dir, 'design', { evaluator: 'design', verdict: 'PASS', subject: again.agents[0].inputs.subject });
  next(project, name);
  await writeFile(resolve(dir, 'plan.md'), '# Plan\n\n## Steps\n\n### S1 — screen\n- Covers: AC-1, AC-2\n');
  await report(dir, 'plan', { evaluator: 'plan', verdict: 'PASS', subject: next(project, name).agents[0].inputs.subject });
  assert.equal(next(project, name).do, 'gate');
  // A new design version makes the plan's evaluation stale.
  await writeFile(resolve(dir, 'design.md'), '# Design\n## Screens\n### Settings\n');
  const designEval = next(project, name);
  await report(dir, 'design', { evaluator: 'design', verdict: 'PASS', subject: designEval.agents[0].inputs.subject });
  const planEval = next(project, name);
  assert.deepEqual([agentsOf(planEval).join(), planEval.agents[0].inputs.focus], ['peos:eval-plan', undefined]);
  // A changed spec makes both the design and plan evaluations stale.
  await writeFile(resolve(dir, 'spec.md'), uiSpec() + '- AC-3: c\n');
  const specEval = next(project, name);
  await report(dir, 'spec', { evaluator: 'spec', verdict: 'PASS', subject: specEval.agents[0].inputs.subject });
  const after = next(project, name);
  assert.equal(after.agents[0].agent, 'peos:eval-design');
  const state = JSON.parse(await readFile(resolve(dir, 'state.json')));
  assert.deepEqual([state.evals.design, state.evals.plan], [undefined, undefined]);
});

test('a run recorded with the earlier design evaluation key keeps its evaluation', async t => {
  const { project, name, dir } = await start(t, { tier: 'standard' });
  const path = resolve(dir, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.gates = { spec: { status: 'pending' }, design: { status: 'pending' }, plan: { status: 'pending' } };
  state.evals = { 'plan-design': { verdict: 'PASS', round: 1, subject: sha('x') } };
  await writeFile(path, JSON.stringify(state));
  assert.deepEqual(Object.keys((await readState(dir)).evals), ['design']);
  assert.equal(cliRun(project, 'status', ['--run', name]).assessment.evals.design.verdict, 'PASS');
});

test('a passed run gets one polish round for its medium findings, and its changes are checked and evaluated again', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  next(project, name);
  await writeFile(resolve(dir, 'task.md'), '# Export\n## Acceptance criteria\n- AC-1: x\n## Plan\n- S1: export — files: a — covers: AC-1 — test: t\n');
  next(project, name);
  await writeFile(resolve(project, 'export.js'), 'export function toCsv() {}\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  next(project, name);
  const medium = { id: 'F1', severity: 'medium', file: 'export.js', problem: 'an empty list has no test', impact: 'a regression there goes unseen', fix: 'add a test for an empty list' };
  const low = { id: 'F2', severity: 'low', problem: 'a name could be clearer', impact: 'none', fix: 'rename' };
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project), findings: [medium, low] });
  const polish = next(project, name);
  assert.deepEqual([polish.do, agentsOf(polish).join(), polish.then], ['spawn', 'peos:implementer', 'next']);
  assert.deepEqual(polish.agents[0].inputs.polish, [{ evaluation: 'code-all', id: 'F1', file: 'export.js', problem: 'an empty list has no test', fix: 'add a test for an empty list' }], 'medium only');
  assert.equal(polish.agents[0].inputs.findings, undefined);
  assert.equal(JSON.parse(await readFile(resolve(dir, 'state.json'))).polish, 'done');
  // What the polish changes is a change like any other: checks, then the evaluation of the delta.
  await writeFile(resolve(project, 'export.test.js'), 'import "./export.js";\n');
  const again = next(project, name);
  assert.deepEqual([again.do, again.command], ['run', 'finish']);
  cliRun(project, 'finish', again.args);
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate), ['peos:eval-code']);
  // A medium finding that is still there does not start a second round.
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project), findings: [medium] });
  const summary = next(project, name);
  assert.deepEqual([summary.do, summary.stage], ['write', 'release']);
});

test('a polish round that changes nothing ends the run, and a run without medium findings has none', async t => {
  const { project, name, dir } = await start(t, { tier: 'small' });
  next(project, name);
  await writeFile(resolve(dir, 'task.md'), '# Export\n## Acceptance criteria\n- AC-1: x\n## Plan\n- S1: export — files: a — covers: AC-1 — test: t\n');
  next(project, name);
  await writeFile(resolve(project, 'export.js'), 'export function toCsv() {}\n');
  cliRun(project, 'finish', next(project, name, ['--done', 'S1']).args);
  next(project, name);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project),
    findings: [{ id: 'F1', severity: 'medium', problem: 'needs a product decision', impact: 'unclear', fix: 'ask' }] });
  assert.equal(next(project, name).agents[0].inputs.polish.length, 1);
  assert.deepEqual([next(project, name).do, next(project, name).stage], ['write', 'release'], 'the implementer left it: nothing to check again');
});
