import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { check, config, git, jsonCli, repository, saveConfig } from './helpers.mjs';

const cliRun = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]);
// Decisions need the user's grant; these tests record one through the CLI first (the hook path is tested separately).
const decisions = { approve: '--gate', revise: '--gate', 'reset-eval': '--key' };
function run(project, action, args = []) {
  if (decisions[action]) {
    const option = value => args[args.indexOf(value) + 1];
    cliRun(project, 'grant', ['--action', action, '--target', option(decisions[action]), '--run', option('--run')]);
  }
  return cliRun(project, action, args);
}
const sha = text => createHash('sha256').update(text).digest('hex');
const runDir = (project, name) => resolve(project, '.project-os/runs', name);
async function start(t, tier = 'standard', checks = [check()]) {
  const project = await repository(t);
  await saveConfig(project, config(checks));
  const { report } = run(project, 'init', ['--name', 'avatar-upload', '--type', 'feature', '--tier', tier]);
  assert.equal(report.status, 'PASS');
  return { project, name: report.run, dir: report.directory };
}
async function submit(t, project, name, report) {
  const scratch = await mkdtemp(resolve(tmpdir(), 'peos-report-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = resolve(scratch, 'report.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, mode: 'full', criteria: [], findings: [], notAssessed: [], ...report }));
  return run(project, 'record-eval', ['--run', name, '--report', path]);
}
async function approveArtifact(t, project, name, gate, text) {
  const file = { spec: 'spec.md', plan: 'plan.md', architecture: 'architecture.md' }[gate];
  await writeFile(resolve(runDir(project, name), file), text);
  const evaluator = gate === 'spec' ? { evaluator: 'spec' } : gate === 'plan' ? { evaluator: 'plan' } : { evaluator: 'plan', focus: 'architecture' };
  assert.equal((await submit(t, project, name, { ...evaluator, verdict: 'PASS', subject: `sha256:${sha(text)}` })).report.status, 'PASS');
  return run(project, 'approve', ['--run', name, '--gate', gate]);
}

test('init creates validated state, run-local ignore rules and tier gates', async t => {
  const { project, name, dir } = await start(t, 'large');
  const state = JSON.parse(await readFile(resolve(dir, 'state.json')));
  assert.match(name, /^\d{4}-\d{2}-\d{2}-avatar-upload$/);
  assert.deepEqual(Object.keys(state.gates), ['spec', 'architecture', 'plan']);
  assert.equal(state.stage, 'intake');
  const ignored = (await readFile(resolve(dir, '.gitignore'), 'utf8')).split('\n');
  for (const entry of ['state.json', 'checks.json', 'changes.diff', 'evals/', 'pending-eval.json']) assert.ok(ignored.includes(entry), entry);
  assert.equal(run(project, 'init', ['--name', 'avatar-upload', '--type', 'feature', '--tier', 'small']).report.error.code, 'RUN_EXISTS');
  assert.equal(run(project, 'init', ['--name', 'habit', '--type', 'app', '--tier', 'standard']).report.error.code, 'INVOCATION');
  assert.equal(run(project, 'init', ['--name', '../x', '--type', 'fix', '--tier', 'small']).report.error.code, 'INVOCATION');
  assert.deepEqual(run(project, 'status').report.runs.map(entry => entry.stage), ['intake']);
});

test('fingerprint tracks working-tree content and ignores run artifacts', async t => {
  const { project, dir } = await start(t);
  const first = run(project, 'fingerprint').report.codeState;
  await writeFile(resolve(dir, 'notes.md'), 'run artifact');
  assert.equal(run(project, 'fingerprint').report.codeState, first);
  await writeFile(resolve(project, 'base.txt'), 'changed\n');
  const changed = run(project, 'fingerprint').report.codeState;
  assert.notEqual(changed, first);
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  assert.equal(run(project, 'fingerprint').report.codeState, first);
  await writeFile(resolve(project, 'new.txt'), 'untracked');
  assert.notEqual(run(project, 'fingerprint').report.codeState, first);
  await unlink(resolve(project, 'new.txt'));
  await unlink(resolve(project, 'base.txt'));
  assert.notEqual(run(project, 'fingerprint').report.codeState, first);
});

test('human gates need a fresh PASS evaluation, follow order, and go stale on edits', async t => {
  const { project, name } = await start(t);
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'spec']).report.error.code, 'GATE');
  await writeFile(resolve(runDir(project, name), 'plan.md'), 'plan v1');
  await submit(t, project, name, { evaluator: 'plan', verdict: 'PASS', subject: `sha256:${sha('plan v1')}` });
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'plan']).report.error.code, 'GATE', 'the spec is unevaluated');
  assert.equal((await approveArtifact(t, project, name, 'spec', 'spec v1')).report.status, 'PASS');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.error.code, 'GATE');
  // Approving spec discarded the plan evaluation recorded before it.
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'plan']).report.error.code, 'GATE');
  await submit(t, project, name, { evaluator: 'plan', verdict: 'PASS', subject: `sha256:${sha('plan v1')}` });
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'plan']).report.status, 'PASS');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.stage, 'implement');
  // Editing an approved upstream artifact invalidates it and every later gate.
  await writeFile(resolve(runDir(project, name), 'spec.md'), 'spec v2');
  const { gates } = run(project, 'status', ['--run', name]).report.assessment;
  assert.deepEqual([gates.spec.fresh, gates.plan.fresh], [false, false]);
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'evaluate']).report.error.code, 'GATE');
});

test('stale reports are rejected and failed rounds are capped at three', async t => {
  const { project, name } = await start(t);
  await writeFile(resolve(runDir(project, name), 'spec.md'), 'spec');
  assert.equal((await submit(t, project, name, { evaluator: 'spec', verdict: 'PASS', subject: `sha256:${sha('other')}` })).report.error.code, 'STALE');
  const fail = { evaluator: 'spec', verdict: 'FAIL', subject: `sha256:${sha('spec')}` };
  for (const round of [1, 2, 3]) assert.equal((await submit(t, project, name, fail)).report.round, round);
  assert.equal((await submit(t, project, name, fail)).report.error.code, 'ROUND_LIMIT');
  const malformed = await submit(t, project, name, { evaluator: 'spec', verdict: 'PASS', subject: `sha256:${sha('spec')}`, criteria: [{ id: 'AC-1', status: 'not_met', evidence: 'x' }] });
  assert.equal(malformed.report.error.code, 'EVAL_REPORT');
  const small = await start(t, 'small');
  await writeFile(resolve(small.dir, 'spec.md'), 'spec');
  assert.match((await submit(t, small.project, small.name, { evaluator: 'spec', verdict: 'PASS', subject: `sha256:${sha('spec')}` })).report.error.message, /no spec gate/);
});

test('revision reopens the gate and later gates and discards their evaluations', async t => {
  const { project, name } = await start(t);
  await approveArtifact(t, project, name, 'spec', 'spec');
  await approveArtifact(t, project, name, 'plan', 'plan');
  const { report } = run(project, 'revise', ['--run', name, '--gate', 'spec']);
  assert.deepEqual(report.gates, { spec: { status: 'revision_requested' }, plan: { status: 'pending' } });
  assert.equal(report.stage, 'spec');
  assert.deepEqual(run(project, 'status', ['--run', name]).report.state.evals, {});
});

test('release requires full PASS checks and PASS code evaluations for the current code state', async t => {
  const { project, name, dir } = await start(t, 'small');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.stage, 'implement');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'release']).report.error.code, 'EVIDENCE');
  const checks = run(project, 'record-checks', ['--run', name, '--phase', 'task']);
  assert.equal(checks.status, 0);
  const codeState = run(project, 'fingerprint').report.codeState;
  assert.equal(JSON.parse(await readFile(resolve(dir, 'checks.json'))).codeState, codeState);
  assert.match(run(project, 'advance', ['--run', name, '--to', 'release']).report.error.message, /at least one code evaluation/i);
  await submit(t, project, name, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: codeState });
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'release']).report.stage, 'release');
  assert.match(run(project, 'advance', ['--run', name, '--to', 'done']).report.error.message, /release-phase/);
  assert.equal(run(project, 'record-checks', ['--run', name, '--phase', 'release']).status, 0);
  await writeFile(resolve(project, 'base.txt'), 'changed after evaluation\n');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'done']).report.error.code, 'EVIDENCE');
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'done']).report.stage, 'done');
  assert.equal(run(project, 'revise', ['--run', name, '--gate', 'spec']).report.error.code, 'TRANSITION');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'stopped']).report.error.code, 'TRANSITION');
});

test('record-checks propagates failures and partial verification never satisfies release', async t => {
  const { project, name } = await start(t, 'trivial', [check('pass'), check('broken', 'process.exit(3)')]);
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  const failed = run(project, 'record-checks', ['--run', name, '--phase', 'task']);
  assert.equal(failed.status, 1); assert.equal(failed.report.checks.status, 'FAIL');
  const partial = run(project, 'record-checks', ['--run', name, '--phase', 'task', '--checks', '["pass"]']);
  assert.equal(partial.status, 0); assert.equal(partial.report.checks.verification, 'partial');
  await submit(t, project, name, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: run(project, 'fingerprint').report.codeState });
  assert.match(run(project, 'advance', ['--run', name, '--to', 'release']).report.error.message, /full PASS verification/);
});

test('state integrity: corrupt state, symlinked parents and held locks are refused', async t => {
  const { project, name, dir } = await start(t);
  await writeFile(resolve(dir, 'state.lock'), '');
  assert.equal(run(project, 'step', ['--run', name, '--step', 'S1', '--status', 'done']).report.error.code, 'LOCKED');
  await unlink(resolve(dir, 'state.lock'));
  assert.deepEqual(run(project, 'step', ['--run', name, '--step', 'S1', '--status', 'done']).report.steps, { S1: 'done' });
  const state = JSON.parse(await readFile(resolve(dir, 'state.json')));
  await writeFile(resolve(dir, 'state.json'), JSON.stringify({ ...state, gates: { spec: { status: 'approved' } } }));
  assert.equal(run(project, 'status', ['--run', name]).report.error.code, 'STATE');
  const other = await repository(t);
  await symlink(resolve(project, '.project-os'), resolve(other, '.project-os'));
  assert.equal(run(other, 'status', ['--run', name]).report.error.code, 'RUN');
  assert.equal(run(project, 'status', ['--run', '../../x']).report.error.code, 'INVOCATION');
  assert.equal(run(project, 'unknown').report.error.code, 'INVOCATION');
});

test('re-approving an earlier gate reopens later gates instead of reviving them', async t => {
  const { project, name } = await start(t);
  await approveArtifact(t, project, name, 'spec', 'spec v1');
  await approveArtifact(t, project, name, 'plan', 'plan v1');
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'spec']).report.gates.plan.status, 'approved', 'repeat approval is a no-op');
  await approveArtifact(t, project, name, 'spec', 'spec v2');
  const { report } = run(project, 'status', ['--run', name]);
  assert.deepEqual(report.state.gates.plan, { status: 'pending' });
  assert.equal(Object.hasOwn(report.state.evals, 'plan'), false);
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.error.code, 'GATE');
});

test('release needs a code evaluation, and large runs need every code focus', async t => {
  const small = await start(t, 'small');
  run(small.project, 'advance', ['--run', small.name, '--to', 'implement']);
  run(small.project, 'record-checks', ['--run', small.name, '--phase', 'task']);
  const codeState = run(small.project, 'fingerprint').report.codeState;
  await submit(t, small.project, small.name, { evaluator: 'security', verdict: 'PASS', subject: codeState });
  assert.match(run(small.project, 'advance', ['--run', small.name, '--to', 'release']).report.error.message, /at least one code evaluation/i);
  const large = await start(t, 'large');
  await approveArtifact(t, large.project, large.name, 'spec', 'spec');
  await approveArtifact(t, large.project, large.name, 'architecture', 'architecture');
  await approveArtifact(t, large.project, large.name, 'plan', 'plan');
  run(large.project, 'advance', ['--run', large.name, '--to', 'implement']);
  run(large.project, 'record-checks', ['--run', large.name, '--phase', 'task']);
  const subject = run(large.project, 'fingerprint').report.codeState;
  await submit(t, large.project, large.name, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject });
  assert.match(run(large.project, 'advance', ['--run', large.name, '--to', 'release']).report.error.message, /code-acceptance, code-quality, code-tests/);
  for (const focus of ['acceptance', 'quality', 'tests']) await submit(t, large.project, large.name, { evaluator: 'code', focus, verdict: 'PASS', subject });
  assert.equal(run(large.project, 'advance', ['--run', large.name, '--to', 'release']).report.stage, 'release');
});

test('round limit stops a key until the human resets it; PASS restarts the count', async t => {
  const { project, name } = await start(t, 'small');
  const subject = run(project, 'fingerprint').report.codeState;
  const fail = { evaluator: 'code', focus: 'all', verdict: 'FAIL', subject };
  for (const round of [1, 2, 3]) assert.equal((await submit(t, project, name, fail)).report.round, round);
  assert.equal((await submit(t, project, name, { ...fail, verdict: 'PASS' })).report.error.code, 'ROUND_LIMIT');
  assert.deepEqual(run(project, 'reset-eval', ['--run', name, '--key', 'code-all']).report.evals, {});
  assert.equal((await submit(t, project, name, { ...fail, verdict: 'PASS' })).report.round, 1);
  assert.equal((await submit(t, project, name, fail)).report.round, 1, 'a FAIL after PASS starts a new series');
  assert.equal(run(project, 'reset-eval', ['--run', name, '--key', 'code-quality']).report.error.code, 'INVOCATION');
});

test('run files are never followed through symlinks', async t => {
  const { project, name, dir } = await start(t, 'small');
  const outside = await mkdtemp(resolve(tmpdir(), 'peos-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, resolve(dir, 'evals'));
  const result = await submit(t, project, name, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: run(project, 'fingerprint').report.codeState });
  assert.equal(result.report.error.code, 'RUN');
  assert.deepEqual(await readdir(outside), []);
  await unlink(resolve(dir, 'evals'));
  await writeFile(resolve(outside, 'checks.json'), JSON.stringify({ status: 'PASS' }));
  await symlink(resolve(outside, 'checks.json'), resolve(dir, 'checks.json'));
  assert.equal(run(project, 'status', ['--run', name]).report.error.code, 'RUN');
});

test('fingerprint covers hidden index flags and refuses uncoverable nested repositories', async t => {
  const { project, name } = await start(t);
  const first = run(project, 'fingerprint').report.codeState;
  git(project, 'update-index', '--assume-unchanged', 'base.txt');
  await writeFile(resolve(project, 'base.txt'), 'hidden change\n');
  assert.notEqual(run(project, 'fingerprint').report.codeState, first);
  git(project, 'update-index', '--no-assume-unchanged', 'base.txt');
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  git(project, 'update-index', '--skip-worktree', 'base.txt');
  await writeFile(resolve(project, 'base.txt'), 'skipped change\n');
  assert.notEqual(run(project, 'fingerprint').report.codeState, first);
  git(project, 'update-index', '--no-skip-worktree', 'base.txt');
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  assert.equal(run(project, 'fingerprint').report.codeState, first);
  const nested = resolve(project, 'vendor-lib');
  await mkdir(nested);
  git(nested, 'init', '-b', 'main');
  await writeFile(resolve(nested, 'a.txt'), 'a');
  assert.equal(run(project, 'fingerprint').report.error.code, 'FINGERPRINT');
  const { report } = run(project, 'status', ['--run', name]);
  assert.equal(report.codeState, null);
  assert.match(report.codeStateError, /nested repository/);
  assert.deepEqual(Object.keys(report.assessment.gates), ['spec', 'plan']);
});

test('record-eval reads a report from stdin and status exposes artifact hashes', async t => {
  const { project, name, dir } = await start(t);
  await writeFile(resolve(dir, 'spec.md'), 'spec');
  assert.equal(run(project, 'status', ['--run', name]).report.artifacts.spec, `sha256:${sha('spec')}`);
  const input = JSON.stringify({ schemaVersion: 1, evaluator: 'spec', verdict: 'PASS', mode: 'full', subject: `sha256:${sha('spec')}`,
    criteria: [], findings: [], notAssessed: [] });
  const result = jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', name, '--report', '-'], { input });
  assert.equal(result.report.key, 'spec');
  assert.equal(jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', name, '--report', '-'], { input: 'not json' }).report.error.code, 'EVAL_REPORT');
});

test('the documented standard procedure runs end to end through the plan gate', async t => {
  const { project, name, dir } = await start(t);
  const short = name.slice(11);
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'spec']).report.stage, 'spec');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'plan']).report.error.code, 'GATE', 'planning needs an evaluated spec');
  const status = run(project, 'status', ['--run', short]).report;
  assert.equal(status.directory, dir);
  await writeFile(resolve(status.directory, 'spec.md'), 'spec');
  const subject = run(project, 'status', ['--run', short]).report.artifacts.spec;
  const report = input => jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', short, '--report', '-'], { input: JSON.stringify(input) }).report;
  const base = { schemaVersion: 1, mode: 'full', criteria: [], findings: [], notAssessed: [] };
  assert.equal(report({ ...base, evaluator: 'spec', verdict: 'FAIL', subject, findings: [{ id: 'F1', severity: 'high', problem: 'p', impact: 'i', fix: 'f' }] }).key, 'spec');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'plan']).report.error.code, 'GATE', 'a failed evaluation does not open planning');
  assert.equal(report({ ...base, evaluator: 'spec', verdict: 'PASS', subject }).key, 'spec');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'plan']).report.stage, 'plan');
  await writeFile(resolve(dir, 'plan.md'), 'plan');
  const passPlan = () => report({ ...base, evaluator: 'plan', verdict: 'PASS', subject: run(project, 'status', ['--run', short]).report.artifacts.plan });
  assert.equal(passPlan().key, 'plan');
  // Before the decision the spec can change without a command; the plan is judged again.
  await writeFile(resolve(dir, 'spec.md'), 'spec v2');
  assert.equal(run(project, 'approve', ['--run', short, '--gate', 'plan']).report.error.code, 'GATE', 'the changed spec is unevaluated');
  const revised = run(project, 'status', ['--run', short]).report.artifacts.spec;
  assert.equal(report({ ...base, evaluator: 'spec', verdict: 'PASS', subject: revised }).key, 'spec');
  assert.equal(run(project, 'approve', ['--run', short, '--gate', 'plan']).report.error.code, 'GATE', 'the plan evaluation was discarded');
  passPlan();
  const { gates } = run(project, 'approve', ['--run', short, '--gate', 'plan']).report;
  assert.deepEqual([gates.spec.status, gates.spec.by, gates.spec.artifactHash, gates.plan.status], ['approved', 'human', revised, 'approved'], 'one decision covers both');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'implement']).report.stage, 'implement');
  assert.deepEqual(run(project, 'step', ['--run', short, '--step', 'S1,S2', '--status', 'done']).report.steps, { S1: 'done', S2: 'done' }, 'a batch is one call');
  assert.equal(run(project, 'step', ['--run', short, '--step', 'S1,', '--status', 'done']).report.error.code, 'INVOCATION');
  await writeFile(resolve(dir, 'spec.md'), 'spec v3');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'verify']).report.error.code, 'GATE', 'after the decision a spec change needs a new one');
});

test('begin and finish replace the bookkeeping calls around an implementer', async t => {
  const { project, name } = await start(t, 'small');
  const begun = run(project, 'begin', ['--run', name, '--step', 'S1,S2']).report;
  assert.deepEqual([begun.stage, begun.steps], ['implement', { S1: 'in_progress', S2: 'in_progress' }]);
  assert.match(await readFile(begun.mapPath, 'utf8'), /Code map/);
  await writeFile(resolve(project, 'a.txt'), 'change');
  const finished = run(project, 'finish', ['--run', name, '--step', 'S1,S2']);
  assert.deepEqual([finished.report.stage, finished.report.checks, finished.report.failed], ['evaluate', 'PASS', []]);
  assert.ok(finished.report.codeState.startsWith('fp:') && finished.report.diffPath);
  const brief = run(project, 'brief', ['--run', name]).report;
  assert.deepEqual([brief.stage, brief.steps, brief.tier], ['evaluate', { S1: 'done', S2: 'done' }, 'small']);
  assert.ok(!Object.hasOwn(brief, 'state'));
  assert.equal(run(project, 'brief').report.error.code, 'INVOCATION');
});

test('finish stops at verify and names the failing checks', async t => {
  const { project, name } = await start(t, 'small', [check('tests', 'process.exit(1)')]);
  run(project, 'begin', ['--run', name, '--step', 'S1']);
  const failed = run(project, 'finish', ['--run', name, '--step', 'S1']);
  assert.deepEqual([failed.report.stage, failed.report.checks, failed.report.failed], ['verify', 'FAIL', ['tests']]);
  assert.equal(run(project, 'status', ['--run', name]).report.state.stage, 'verify');
});

test('a large run still decides each gate on its own', async t => {
  const { project, name } = await start(t, 'large');
  await writeFile(resolve(runDir(project, name), 'spec.md'), 'spec');
  await submit(t, project, name, { evaluator: 'spec', verdict: 'PASS', subject: `sha256:${sha('spec')}` });
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'plan']).report.error.code, 'GATE');
  assert.equal(run(project, 'approve', ['--run', name, '--gate', 'plan']).report.error.code, 'GATE');
});

test('trivial runs have no gates and go straight to implementation', async t => {
  const { project, name } = await start(t, 'trivial');
  assert.deepEqual(run(project, 'status', ['--run', name]).report.state.gates, {});
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.stage, 'implement');
});

test('short run names resolve uniquely and the last failed round is flagged', async t => {
  const { project, name, dir } = await start(t, 'small');
  await mkdir(resolve(dir, '..', '2020-01-01-avatar-upload'));
  assert.equal(run(project, 'status', ['--run', 'avatar-upload']).report.error.code, 'AMBIGUOUS');
  assert.equal(run(project, 'status', ['--run', 'missing-run']).report.error.code, 'RUN_MISSING');
  const subject = run(project, 'fingerprint').report.codeState;
  const fail = { evaluator: 'code', focus: 'all', verdict: 'FAIL', subject };
  const flags = [];
  for (let round = 0; round < 3; round++) flags.push((await submit(t, project, name, fail)).report.limitReached);
  assert.deepEqual(flags, [false, false, true]);
});

test('changes writes the run diff and reports deterministic security triggers', async t => {
  const { project, name, dir } = await start(t, 'small');
  assert.equal(run(project, 'changes', ['--run', name]).report.error.code, 'TRANSITION', 'needs the implement binding');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  let report = run(project, 'changes', ['--run', name]).report;
  assert.deepEqual(report.securityTriggers, []);
  await writeFile(resolve(project, 'base.txt'), 'base\nconst token = jwt.sign(payload, secret);\n');
  await writeFile(resolve(project, 'reader.js'), "import fs from 'node:fs';\nexport const read = () => fs.readFileSync(process.argv[2]);\n");
  await writeFile(resolve(dir, 'notes.md'), 'jwt.sign in run files is ignored');
  report = run(project, 'changes', ['--run', name]).report;
  // The fixture's untracked configuration is a change too; only run files are excluded.
  assert.deepEqual(report.files.map(file => [file.status, file.path]), [['M', 'base.txt'], ['?', '.project-os/engineering.config.json'], ['?', 'reader.js']]);
  assert.deepEqual(report.securityTriggers, ['authentication', 'cryptography', 'file-system', 'secrets', 'user-input']);
  const diff = await readFile(report.diffPath, 'utf8');
  assert.match(diff, /\+const token = jwt\.sign/);
  assert.match(diff, /\+\+\+ b\/"reader\.js" \(untracked\)/);
  assert.doesNotMatch(diff, /notes\.md/);
  assert.equal(report.codeState, run(project, 'fingerprint').report.codeState);
});

test('recorded checks must use the configuration in force when implementation started', async t => {
  const { project, name } = await start(t, 'small');
  assert.equal(run(project, 'advance', ['--run', name, '--to', 'implement']).report.stage, 'implement');
  const started = run(project, 'status', ['--run', name]).report.state.configHash;
  assert.match(started, /^sha256:/);
  await saveConfig(project, config([check('weakened', 'process.exit(0)')]));
  run(project, 'record-checks', ['--run', name, '--phase', 'task']);
  await submit(t, project, name, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: run(project, 'fingerprint').report.codeState });
  assert.match(run(project, 'advance', ['--run', name, '--to', 'release']).report.error.message, /configuration this run started/);
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  assert.equal(run(project, 'status', ['--run', name]).report.state.configHash, started, 're-entering implement keeps the original binding');
});

test('changes reads only regular untracked text, scans non-test code, and diffs against the run base', async t => {
  const { project, name } = await start(t, 'small');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  const outside = await mkdtemp(resolve(tmpdir(), 'peos-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(outside, 'secret.txt'), 'OUTSIDE_SECRET');
  await symlink(resolve(outside, 'secret.txt'), resolve(project, 'link.txt'));
  await writeFile(resolve(project, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  await writeFile(resolve(project, 'author.js'), 'export const author = "Ada";\n');
  await mkdir(resolve(project, 'test'));
  await writeFile(resolve(project, 'test/io.test.js'), "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');\n");
  let report = run(project, 'changes', ['--run', name]).report;
  let diff = await readFile(report.diffPath, 'utf8');
  assert.doesNotMatch(diff, /OUTSIDE_SECRET/);
  assert.match(diff, /symlink -> /);
  assert.match(diff, /binary file, 4 bytes/);
  assert.deepEqual(report.securityTriggers, [], 'author is not authentication; test-file I/O is not a trigger');
  await writeFile(resolve(project, 'run.py'), 'import subprocess, sys\nsubprocess.run(sys.argv[1:])\n');
  await writeFile(resolve(project, 'ask.py'), 'from anthropic import Anthropic\n');
  assert.ok(run(project, 'changes', ['--run', name]).report.securityTriggers.includes('llm'));
  await unlink(resolve(project, 'ask.py'));
  assert.deepEqual(run(project, 'changes', ['--run', name]).report.securityTriggers, ['code-execution', 'user-input']);
  // A commit during the run stays visible: the diff base is the commit the run started from.
  git(project, 'add', 'author.js');
  git(project, 'commit', '-m', 'step one');
  report = run(project, 'changes', ['--run', name]).report;
  assert.ok(report.files.some(file => file.path === 'author.js' && file.status === 'A'), 'committed step is still in the diff');
});

test('implementation needs a configuration and later stages need the implement binding', async t => {
  const project = await repository(t);
  const { report } = run(project, 'init', ['--name', 'nocfg', '--type', 'fix', '--tier', 'small']);
  assert.equal(run(project, 'advance', ['--run', report.run, '--to', 'verify']).report.error.code, 'TRANSITION');
  assert.equal(run(project, 'advance', ['--run', report.run, '--to', 'implement']).report.error.code, 'CONFIG_MISSING');
  await saveConfig(project, config());
  assert.equal(run(project, 'advance', ['--run', report.run, '--to', 'implement']).report.stage, 'implement');
  assert.equal(run(project, 'status', ['--run', report.run]).report.state.baseHead, git(project, 'rev-parse', 'HEAD').trim());
});

test('a sparse checkout does not report out-of-cone files as changes', async t => {
  const { project, name } = await start(t, 'small');
  await mkdir(resolve(project, 'other'));
  await writeFile(resolve(project, 'other/secrets.txt'), 'x');
  await writeFile(resolve(project, 'other/package.json'), '{}');
  git(project, 'add', 'other'); git(project, 'commit', '-m', 'other');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  git(project, 'sparse-checkout', 'set', '--no-cone', '/base.txt', '/.project-os/');
  const report = run(project, 'changes', ['--run', name]).report;
  assert.deepEqual(report.files.filter(file => file.path.startsWith('other/')), []);
  assert.deepEqual(report.securityTriggers, []);
});

test('a refactor needs a green baseline on the untouched base and reports changed existing tests', async t => {
  const { project, name } = await start(t, 'small');
  const refactor = run(project, 'init', ['--name', 'split', '--type', 'refactor', '--tier', 'small']).report.run;
  assert.equal(run(project, 'record-baseline', ['--run', refactor]).report.error.code, 'TRANSITION');
  await mkdir(resolve(project, 'test'));
  await writeFile(resolve(project, 'test/base.test.js'), 'assert(true)\n');
  git(project, 'add', 'test'); git(project, 'commit', '-m', 'tests');
  run(project, 'advance', ['--run', refactor, '--to', 'implement']);
  await writeFile(resolve(project, 'base.txt'), 'changed first\n');
  assert.equal(run(project, 'record-baseline', ['--run', refactor]).report.error.code, 'BASELINE', 'too late: code already changed');
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  const baseline = jsonCli('peos-run.mjs', ['record-baseline', '--project', project, '--run', refactor]);
  assert.equal(baseline.status, 0); assert.equal(baseline.report.baseline.status, 'PASS');
  await writeFile(resolve(project, 'base.txt'), 'refactored\n');
  await writeFile(resolve(project, 'test/base.test.js'), 'assert(false)\n');
  const changes = run(project, 'changes', ['--run', refactor]).report;
  assert.deepEqual(changes.modifiedTests, ['test/base.test.js']);
  run(project, 'advance', ['--run', refactor, '--to', 'verify']);
  run(project, 'record-checks', ['--run', refactor, '--phase', 'task']);
  run(project, 'advance', ['--run', refactor, '--to', 'evaluate']);
  await submit(t, project, refactor, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: changes.codeState });
  assert.equal(run(project, 'advance', ['--run', refactor, '--to', 'release']).report.stage, 'release');
  // The same evidence without a baseline is not enough for a refactor; other types never need one.
  const other = run(project, 'init', ['--name', 'nobase', '--type', 'refactor', '--tier', 'small']).report.run;
  run(project, 'advance', ['--run', other, '--to', 'implement']);
  run(project, 'advance', ['--run', other, '--to', 'verify']);
  run(project, 'record-checks', ['--run', other, '--phase', 'task']);
  run(project, 'advance', ['--run', other, '--to', 'evaluate']);
  await submit(t, project, other, { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: run(project, 'fingerprint').report.codeState });
  assert.match(run(project, 'advance', ['--run', other, '--to', 'release']).report.error.message, /refactor needs a full PASS baseline/);
  assert.equal(run(project, 'status', ['--run', name]).report.assessment.baseline, null, 'feature runs have no baseline');
});

test('the refactor baseline binds to the start state, and moved or snapshot tests are classified', async t => {
  const { project } = await start(t, 'small');
  await mkdir(resolve(project, 'test'));
  await writeFile(resolve(project, 'test/a.test.js'), 'a\n'.repeat(20));
  await writeFile(resolve(project, 'test/b.test.js'), 'b\n'.repeat(20));
  git(project, 'add', 'test'); git(project, 'commit', '-m', 'tests');
  await writeFile(resolve(project, '.DS_Store'), 'stray');
  const refactor = run(project, 'init', ['--name', 'move', '--type', 'refactor', '--tier', 'small']).report.run;
  run(project, 'advance', ['--run', refactor, '--to', 'implement']);
  assert.equal(run(project, 'record-baseline', ['--run', refactor]).report.baseline.status, 'PASS', 'pre-existing local files do not block the baseline');
  await mkdir(resolve(project, 'spec'));
  git(project, 'mv', 'test/a.test.js', 'spec/a.test.js');
  git(project, 'mv', 'test/b.test.js', 'spec/b.test.js');
  await writeFile(resolve(project, 'spec/b.test.js'), 'b\n'.repeat(19) + 'changed\n');
  await mkdir(resolve(project, 'src/__snapshots__'), { recursive: true });
  await writeFile(resolve(project, 'src/__snapshots__/view.test.js.snap'), 'new snapshot');
  git(project, 'add', '-A', 'src');
  git(project, 'commit', '-m', 'snapshot');
  await writeFile(resolve(project, 'src/__snapshots__/view.test.js.snap'), 'updated snapshot');
  const { modifiedTests } = run(project, 'changes', ['--run', refactor]).report;
  assert.ok(!modifiedTests.includes('test/a.test.js'), 'a pure move is mechanical');
  assert.ok(modifiedTests.includes('test/b.test.js'), 'a move with edits is listed');
  await writeFile(resolve(project, 'base.txt'), 'changed\n');
  assert.equal(run(project, 'record-baseline', ['--run', refactor]).report.error.code, 'BASELINE');
});

test('test paths cover common layouts', async () => {
  const { codeChanges } = await import('../scripts/lib/changes.mjs');
  assert.equal(typeof codeChanges, 'function');
  const source = await readFile(new URL('../scripts/lib/changes.mjs', import.meta.url), 'utf8');
  const testPath = new RegExp(/const testPath = \/(.*)\/;/.exec(source)[1]);
  for (const path of ['pkg/test_foo.py', 'MyAppTests/FooTests.swift', 'app/src/androidTest/X.kt', 'src/FooTest.java', 'src/__snapshots__/a.test.js.snap',
    'pkg/testdata/out.golden', 'svc/foo_test.go', 'tests/unit.rs', 'spec/models/user_spec.rb', 'web/a.spec.ts']) assert.ok(testPath.test(path), path);
  for (const path of ['src/contests/score.js', 'src/latest.js', 'docs/testing.md', 'src/attestation.py']) assert.ok(!testPath.test(path), path);
});

test('floor guard flags lowered bars and collects shortcut markers', async t => {
  const { project, name } = await start(t, 'small');
  await mkdir(resolve(project, 'test'));
  await mkdir(resolve(project, 'src'));
  await writeFile(resolve(project, 'test/a.test.js'), "test('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toBe(3);\n});\n");
  await writeFile(resolve(project, 'test/old.test.js'), "test('old', () => expect(1).toBe(1));\n");
  await writeFile(resolve(project, 'jest.config.js'), "module.exports = { coverageThreshold: { global: { lines: 90 } } };\n");
  await writeFile(resolve(project, 'src/f.js'), 'export const f = x => x + 1;\n');
  git(project, 'add', '-A'); git(project, 'commit', '-m', 'base');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  let report = run(project, 'changes', ['--run', name]).report;
  assert.deepEqual([report.floorFlags, report.shortcuts], [[], []], 'clean start');
  await writeFile(resolve(project, 'test/a.test.js'), "test.skip('a', () => {\n  expect(f(1)).toBe(2);\n});\n");
  await unlink(resolve(project, 'test/old.test.js'));
  await writeFile(resolve(project, 'jest.config.js'), "module.exports = { coverageThreshold: { global: { lines: 50 } } };\n");
  await writeFile(resolve(project, 'src/f.js'), [
    '// eslint-disable-next-line no-eval', 'export const f = x => x + 1;',
    'export function g() { try { risky(); } catch (e) {} }',
    '// shortcut: linear scan, switch to an index above 10k items', '// shortcut: no retries'
  ].join('\n') + '\n');
  report = run(project, 'changes', ['--run', name]).report;
  const kinds = report.floorFlags.map(flag => `${flag.kind}:${flag.file}`).sort();
  assert.deepEqual(kinds, ['assertions-removed:test/a.test.js', 'checker-silenced:src/f.js', 'test-deleted:test/old.test.js',
    'test-made-easier:test/a.test.js', 'threshold-changed:jest.config.js', 'unfinished-work:src/f.js']);
  assert.deepEqual(report.shortcuts.map(marker => [marker.file, marker.hasTrigger]), [['src/f.js', true], ['src/f.js', false]]);
});

test('the code map lists top-level names per folder, shared code first, without tests or vendored code', async t => {
  const { project, name, dir } = await start(t, 'small');
  const files = {
    'src/lib/format.js': 'export function formatDate() {}\nexport const pad = 1;\nfunction hidden() {}\n',
    'src/app.ts': 'export class App {}\nexport { start as run, stop };\n',
    'tools/build.py': 'def build():\n    pass\nclass Builder:\n    pass\ndef _private():\n    pass\n',
    'svc/handler.go': 'package svc\nfunc Handle() {}\nfunc helper() {}\ntype Server struct{}\n',
    'test/app.test.js': 'export function notListed() {}\n',
    'node_modules/x/index.js': 'export function vendored() {}\n'
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(resolve(project, path, '..'), { recursive: true });
    await writeFile(resolve(project, path), text);
  }
  const { report } = run(project, 'map');
  const lines = report.map.split('\n');
  assert.equal(lines[0], 'src/lib/: format.js(formatDate, pad)', 'shared folder first');
  assert.ok(lines.includes('src/: app.ts(App, run, stop)'));
  assert.ok(lines.includes('tools/: build.py(build, Builder)'));
  assert.ok(lines.includes('svc/: handler.go(Handle, Server)'));
  assert.doesNotMatch(report.map, /notListed|vendored|hidden|_private|helper/);
  const written = run(project, 'map', ['--run', name]).report;
  assert.equal(written.mapPath, resolve(dir, 'map.md'));
  assert.match(await readFile(written.mapPath, 'utf8'), /formatDate/);
});

test('floor guard and markers ignore ordinary code, prose and dependency bumps', async t => {
  const { project, name } = await start(t, 'small');
  await mkdir(resolve(project, 'test'));
  await mkdir(resolve(project, 'src'));
  await writeFile(resolve(project, 'package.json'), '{\n  "devDependencies": { "@vitest/coverage-v8": "^1.0.0" }\n}\n');
  await writeFile(resolve(project, 'test/a.test.js'), "it('should add', () => {\n  expect(add(1)).toBe(2);\n});\n");
  await writeFile(resolve(project, 'vite.config.ts'), 'export default { test: { coverage: { thresholds: { lines: 90 } } } };\n');
  await writeFile(resolve(project, 'test/p_test.py'), 'def test_p():\n    assert p() == 1\n');
  git(project, 'add', '-A'); git(project, 'commit', '-m', 'base');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  await writeFile(resolve(project, 'package.json'), '{\n  "devDependencies": { "@vitest/coverage-v8": "^2.0.0" }\n}\n');
  await writeFile(resolve(project, 'test/a.test.js'), "it('adds', () => {\n  expect(add(1)).toBe(2);\n});\n");
  await writeFile(resolve(project, 'src/todo.js'), [
    'export function toggle(todo) { return { ...todo, done: !todo.done }; }',
    "export const handler = (req, res) => res.status(501).send('Not implemented');",
    "export const keys = [{ label: 'Save', shortcut: 'Ctrl+S' }];",
    '/* shortcut: in-memory cache, move to Redis above one instance */ export const cache = new Map(); // shortcut: no TTL'
  ].join('\n') + '\n');
  await writeFile(resolve(project, 'README.md'), 'Export is not implemented yet. TODO: docs. // shortcut: none\n');
  let report = run(project, 'changes', ['--run', name]).report;
  assert.deepEqual(report.floorFlags, [], JSON.stringify(report.floorFlags));
  assert.deepEqual(report.shortcuts.map(marker => [marker.text, marker.hasTrigger]),
    [['in-memory cache, move to Redis above one instance', true], ['no TTL', false]]);
  await writeFile(resolve(project, 'vite.config.ts'), 'export default { test: { coverage: { thresholds: { lines: 10 } } } };\n');
  await writeFile(resolve(project, 'package.json'), '{\n  "devDependencies": { "@vitest/coverage-v8": "^2.0.0" }\n}\n');
  await writeFile(resolve(project, 'src/stub.js'), "export function f() { throw new Error('Not implemented'); }\n/** shortcut: in-memory cache, move to redis with >1 instance */\n");
  await writeFile(resolve(project, 'test/p_test.py'), 'import unittest\n@unittest.skipIf(True, "x")\ndef test_p():\n    p()\n');
  report = run(project, 'changes', ['--run', name]).report;
  assert.deepEqual(report.floorFlags.map(flag => `${flag.kind}:${flag.file}`).sort(),
    ['assertions-removed:test/p_test.py', 'test-made-easier:test/p_test.py', 'threshold-changed:vite.config.ts', 'unfinished-work:src/stub.js']);
  assert.ok(report.shortcuts.some(marker => marker.text === 'in-memory cache, move to redis with >1 instance'), 'one-line JSDoc marker');
});

test('diff sections keep their own paths across type changes, and big folders are shortened in the map', async t => {
  const { project, name } = await start(t, 'small');
  await mkdir(resolve(project, 'test'));
  await writeFile(resolve(project, 'test/a.test.js'), "test('a', () => expect(1).toBe(1));\n");
  await writeFile(resolve(project, 'test/z.test.js'), "test('z', () => expect(1).toBe(1));\n");
  git(project, 'add', '-A'); git(project, 'commit', '-m', 'base');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  await unlink(resolve(project, 'test/a.test.js'));
  await symlink('z.test.js', resolve(project, 'test/a.test.js'));
  await writeFile(resolve(project, 'test/z.test.js'), "test('z', () => {});\n");
  const flags = run(project, 'changes', ['--run', name]).report.floorFlags.map(flag => `${flag.kind}:${flag.file}`);
  assert.ok(flags.includes('assertions-removed:test/z.test.js'), JSON.stringify(flags));
  await mkdir(resolve(project, 'src'));
  for (let i = 0; i < 150; i++) await writeFile(resolve(project, `src/module${i}.js`), `export function handlerNumber${i}() {}\nexport class ServiceNumber${i} {}\n`);
  await writeFile(resolve(project, 'src/base.js'), 'export default class extends Object {}\nexport type { Shape } from "./shape";\n');
  const { report } = run(project, 'map');
  assert.match(report.map, /^src\/: .*module\d+\.js\(handlerNumber\d+, ServiceNumber\d+\).* … \+\d+ file\(s\)$/m);
  assert.ok(report.map.length <= 6000);
  assert.doesNotMatch(report.map, /\(extends\)/);
});

test('threshold flags cover CLI flags and quoted decimals but not versions', async t => {
  const { project, name } = await start(t, 'small');
  await writeFile(resolve(project, 'package.json'), '{\n  "scripts": { "cov": "pytest --cov-fail-under=80", "c8": "c8 --check-coverage --lines 90" },\n  "version": "1.2.3"\n}\n');
  await writeFile(resolve(project, 'build.gradle.kts'), 'limit { minimum = "0.80".toBigDecimal() }\n');
  git(project, 'add', '-A'); git(project, 'commit', '-m', 'base');
  run(project, 'advance', ['--run', name, '--to', 'implement']);
  await writeFile(resolve(project, 'package.json'), '{\n  "scripts": { "cov": "pytest --cov-fail-under=10", "c8": "c8 --check-coverage --lines 10" },\n  "version": "1.2.4"\n}\n');
  await writeFile(resolve(project, 'build.gradle.kts'), 'limit { minimum = "0.10".toBigDecimal() }\n');
  const flags = run(project, 'changes', ['--run', name]).report.floorFlags.filter(flag => flag.kind === 'threshold-changed');
  assert.deepEqual(flags.map(flag => flag.file).sort(), ['build.gradle.kts', 'package.json']);
  assert.ok(flags.every(flag => !/"version"/.test(flag.text)), 'version bump is not a threshold');
});
