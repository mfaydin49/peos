import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { check, config, git, jsonCli, repository, saveConfig } from './helpers.mjs';

const run = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]);
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
  assert.match(await readFile(resolve(dir, '.gitignore'), 'utf8'), /state\.json\n.*checks\.json\nevals\//s);
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
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'plan']).report.error.message, /earlier gates.*spec/);
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
  run(small.project, 'record-checks', ['--run', small.name, '--phase', 'task']);
  const codeState = run(small.project, 'fingerprint').report.codeState;
  await submit(t, small.project, small.name, { evaluator: 'security', verdict: 'PASS', subject: codeState });
  assert.match(run(small.project, 'advance', ['--run', small.name, '--to', 'release']).report.error.message, /at least one code evaluation/i);
  const large = await start(t, 'large');
  await approveArtifact(t, large.project, large.name, 'spec', 'spec');
  await approveArtifact(t, large.project, large.name, 'architecture', 'architecture');
  await approveArtifact(t, large.project, large.name, 'plan', 'plan');
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
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'plan']).report.error.code, 'GATE', 'planning needs an approved spec');
  const status = run(project, 'status', ['--run', short]).report;
  assert.equal(status.directory, dir);
  await writeFile(resolve(status.directory, 'spec.md'), 'spec');
  const subject = run(project, 'status', ['--run', short]).report.artifacts.spec;
  const report = input => jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', short, '--report', '-'], { input: JSON.stringify(input) }).report;
  const base = { schemaVersion: 1, mode: 'full', criteria: [], findings: [], notAssessed: [] };
  assert.equal(report({ ...base, evaluator: 'spec', verdict: 'PASS', subject }).key, 'spec');
  assert.equal(run(project, 'approve', ['--run', short, '--gate', 'spec']).report.status, 'PASS');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'plan']).report.stage, 'plan');
  await writeFile(resolve(dir, 'plan.md'), 'plan');
  assert.equal(report({ ...base, evaluator: 'plan', verdict: 'PASS', subject: run(project, 'status', ['--run', short]).report.artifacts.plan }).key, 'plan');
  assert.equal(run(project, 'approve', ['--run', short, '--gate', 'plan']).report.status, 'PASS');
  assert.equal(run(project, 'advance', ['--run', short, '--to', 'implement']).report.stage, 'implement');
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
