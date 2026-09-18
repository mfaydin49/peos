import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { config, check, fixture, saveConfig, jsonCli, cli, script } from './helpers.mjs';
const verify = (project, extra = []) => jsonCli('verify.mjs', ['--project', project, '--phase', 'task', ...extra]);

test('success and failure preserve outcomes; optional failure remains visible', async t => {
  const project = await fixture(t, config([check('pass'), check('optional', 'process.exit(4)', { required: false }), check('required', 'process.exit(7)')]));
  let result = verify(project);
  assert.equal(result.status, 1); assert.equal(result.report.status, 'FAIL');
  assert.deepEqual(result.report.checks.map(r => [r.status, r.exitCode]), [['PASS', 0], ['FAIL', 4], ['FAIL', 7]]);
  await saveConfig(project, config([check('optional', 'process.exit(4)', { required: false })]));
  result = verify(project);
  assert.equal(result.status, 0); assert.equal(result.report.checks[0].status, 'FAIL');
});
test('missing executable is BLOCKED', async t => {
  const project = await fixture(t, config([check('missing', '', { executable: '/no/such/peos-command' })]));
  const result = verify(project);
  assert.equal(result.status, 1); assert.equal(result.report.checks[0].status, 'BLOCKED');
  assert.equal(result.report.checks[0].exitCode, null); assert.match(result.report.checks[0].reason, /ENOENT/);
});
test('explicit working directory, literal arguments, no package manifest required', async t => {
  const project = await fixture(t);
  const args = ['has space', 'quote"', '$HOME', '$(touch must-not-exist)', '--literal', '', 'line\nbreak'];
  const source = `const fs = require('node:fs'); fs.writeFileSync('actual.json', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}));`;
  await saveConfig(project, config([check('args', '', { args: ['-e', source, '--', ...args] })]));
  const result = verify(project);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(await readFile(resolve(project, 'actual.json'))), { cwd: project, args });
  await assert.rejects(access(resolve(project, 'must-not-exist')));
});
test('JSON stdout contains one object and bounded metadata, never raw logs or secrets', async t => {
  const project = await fixture(t, config([check('noisy', `process.stdout.write('SECRET_MARKER'+ 'x'.repeat(100000)); process.stderr.write('SECRET_MARKER' + 'y'.repeat(100000)); process.exitCode=3;`)]));
  const result = verify(project);
  assert.equal(result.status, 1); assert.ok(!result.stdout.includes('SECRET_MARKER'));
  assert.ok(result.stdout.length < 2500);
  for (const stream of ['stdout', 'stderr']) assert.equal(result.report.checks[0].output[stream].truncated, true);
  const human = cli('verify.mjs', ['--project', project, '--phase', 'task']);
  assert.match(human.stdout, /FAIL/); assert.ok(!human.stdout.includes('SECRET_MARKER'));
});
test('targeted checks are partial, list omitted required and phase skips', async t => {
  const project = await fixture(t, config([check('selected, id'), check('omitted'), check('release', '', { phases: ['release'] })]));
  const result = verify(project, ['--checks', '["selected, id"]']);
  assert.equal(result.status, 0); assert.equal(result.report.verification, 'partial');
  assert.deepEqual(result.report.omittedRequiredChecks, ['omitted']);
  assert.deepEqual(result.report.checks.map(r => r.status), ['PASS', 'SKIPPED', 'SKIPPED']);
  assert.match(result.report.scope, /whole phase not established/);
});
test('manual evidence is never reported as automated completion', async t => {
  const input = { ...config(), manualChecks: [{ id: 'visual', description: 'Review viewports', phases: ['task'], required: true }] };
  const project = await fixture(t, input);
  const result = verify(project);
  assert.equal(result.status, 0); assert.equal(result.report.manualRequirements[0].evidence, 'NOT_ASSESSED');
});
test('invalid selection and invocation fail with structured JSON errors before execution', async t => {
  const project = await fixture(t, config([check('task', '', { phases: ['task'] }), check('release', '', { phases: ['release'] })]));
  for (const selection of ['[]', '["unknown"]', '["release"]', '["task","task"]', 'task', 'null', '[3]']) {
    const result = verify(project, ['--checks', selection]);
    assert.equal(result.status, 2); assert.equal(result.report.error.code, 'SELECTION');
  }
  for (const args of [[], ['--project', project], ['--project', project, '--phase', 'other'], ['--project', project, '--phase', 'task', '--config', 'bad'], ['--json', '--json']]) {
    const result = jsonCli('verify.mjs', args);
    assert.equal(result.status, 2); assert.equal(result.report.status, 'ERROR');
  }
  await saveConfig(project, config([check('task', '', { phases: ['task'] })]));
  const empty = jsonCli('verify.mjs', ['--project', project, '--phase', 'release']);
  assert.equal(empty.status, 2); assert.equal(empty.report.error.code, 'SELECTION');
});
test('missing, malformed, unknown-field configuration never executes commands', async t => {
  const project = await fixture(t, null);
  assert.equal(verify(project).report.error.code, 'CONFIG_MISSING');
  await saveConfig(project, { ...config([check('bad', "require('node:fs').writeFileSync('ran', 'yes')")]), invalid: true });
  assert.equal(verify(project).report.error.code, 'CONFIG');
  await assert.rejects(access(resolve(project, 'ran')));
  await writeFile(resolve(project, '.project-os/engineering.config.json'), '{"secret":INVALID_JSON_SECRET}');
  const result = verify(project);
  assert.equal(result.status, 2); assert.ok(!result.stdout.includes('INVALID_JSON_SECRET'));
});
test('timeout stops process group, including a child ignoring SIGTERM', async t => {
  const project = await fixture(t);
  const descendant = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync('survived','bad'),1600); setInterval(()=>{},1000);`;
  const source = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  await saveConfig(project, config([check('timeout', source, { timeoutMs: 400 })]));
  const result = verify(project);
  assert.equal(result.status, 1); assert.equal(result.report.checks[0].status, 'BLOCKED');
  assert.match(result.report.checks[0].reason, /Timed out/);
  await delay(1800); await assert.rejects(access(resolve(project, 'survived')));
});
for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} blocks remaining selected checks and kills descendants`, { timeout: 15000 }, async t => {
  const project = await fixture(t);
  const descendant = `require('node:fs').writeFileSync('ready','yes'); process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync('survived','bad'),1400); setInterval(()=>{},1000);`;
  const source = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  await saveConfig(project, config([check('active', source, { timeoutMs: 10000 }), check('next', "require('node:fs').writeFileSync('next-ran','bad')")]));
  const child = spawn(process.execPath, [script('verify.mjs'), '--project', project, '--phase', 'task', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  let ready = false;
  for (let n = 0; n < 150; n++) {
    try { await access(resolve(project, 'ready')); ready = true; break; } catch { await delay(20); }
  }
  assert.equal(ready, true);
  child.kill(signal);
  const [code] = await closed;
  assert.equal(code, signal === 'SIGINT' ? 130 : 143); assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.interrupted, true); assert.deepEqual(report.checks.map(r => r.status), ['BLOCKED', 'BLOCKED']);
  await delay(1600);
  await assert.rejects(access(resolve(project, 'survived'))); await assert.rejects(access(resolve(project, 'next-ran')));
});

test('signal termination of the check is BLOCKED with the actual signal', async t => {
  const project = await fixture(t, config([check('signal', "process.kill(process.pid, 'SIGTERM')")]));
  const result = verify(project);
  assert.equal(result.status, 1); assert.equal(result.report.checks[0].status, 'BLOCKED');
  assert.equal(result.report.checks[0].signal, 'SIGTERM'); assert.equal(result.report.checks[0].exitCode, null);
});
test('relative executable path and config resolution do not depend on caller cwd', async t => {
  const project = await fixture(t);
  const elsewhere = await fixture(t, null);
  await writeFile(resolve(project, 'check.sh'), '#!/bin/sh\ntest -f .project-os/engineering.config.json\n', { mode: 0o700 });
  await saveConfig(project, config([check('relative', '', { executable: './check.sh', args: [] })]));
  const result = jsonCli('verify.mjs', ['--project', project, '--phase', 'task'], { cwd: elsewhere });
  assert.equal(result.status, 0); assert.equal(result.report.checks[0].status, 'PASS');
});
test('non-executable file is an execution problem, not a test failure', async t => {
  const project = await fixture(t);
  await writeFile(resolve(project, 'not-executable'), 'test', { mode: 0o600 });
  await saveConfig(project, config([check('permission', '', { executable: './not-executable', args: [] })]));
  const result = verify(project);
  assert.equal(result.status, 1); assert.equal(result.report.checks[0].status, 'BLOCKED');
  assert.match(result.report.checks[0].reason, /EACCES/);
});
