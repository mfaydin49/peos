import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { repository, saveConfig, config, jsonCli } from './helpers.mjs';

// Opt-in runtime probe: uses Codex's actual parser/scanner, no model turn or account request.
// Ordinary `node --test` does not require a Codex installation.
test('installed Codex discovers four linked repository skills from root and nested cwd', {
  skip: process.env.PEOS_CODEX_DISCOVERY !== '1', timeout: 20000
}, async t => {
  const project = await repository(t);
  await saveConfig(project, config());
  assert.equal(jsonCli('setup-codex.mjs', ['--project', project]).status, 0);
  const nested = resolve(project, 'nested'); await mkdir(nested);
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, 'Codex CLI is required for this opt-in test.');
  const state = resolve(project, 'codex-state'); await mkdir(state);
  const child = spawn('codex', ['app-server', '--stdio',
    '-c', `log_dir=${JSON.stringify(resolve(project, 'codex-logs'))}`,
    '-c', `sqlite_home=${JSON.stringify(state)}`], {
    cwd: project, stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map();
  child.stderr.resume(); // Do not expose global configuration or account diagnostics.
  child.on('error', error => { for (const request of pending.values()) request.reject(error); });
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('Codex exited before completing discovery.')); });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Codex RPC failed (${message.error.code}).`));
    else request.resolve(message.result);
  });
  function rpc(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  t.after(async () => {
    lines.close(); child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 500);
    await closed; clearTimeout(force);
  });
  await rpc('initialize', { clientInfo: { name: 'peos_discovery_test', version: '0.1.0' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const result = await rpc('skills/list', { cwds: [project, nested], forceReload: true });
  const expected = ['peos-code-review', 'peos-implementation', 'peos-release-check', 'peos-task-planning'];
  assert.equal(result.data.length, 2);
  for (const entry of result.data) {
    const skills = entry.skills.filter(skill => expected.includes(skill.name));
    assert.deepEqual(skills.map(skill => skill.name).sort(), expected);
    assert.ok(skills.every(skill => skill.enabled && skill.scope === 'repo'));
    assert.equal(entry.errors.filter(error => error.path.includes('peos-')).length, 0);
  }
  t.diagnostic(`${version.stdout.trim()}: all four skills parsed and discovered from both project locations. No model invocation tested.`);
});
