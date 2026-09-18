import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export const toolkit = fileURLToPath(new URL('..', import.meta.url));
export const script = name => resolve(toolkit, 'scripts', name);
export const check = (id = 'test', source = '', overrides = {}) => ({ id, executable: process.execPath,
  args: ['-e', source], phases: ['task', 'release'], required: true, timeoutMs: 3000, ...overrides });
export const config = (checks = [check()]) => ({ schemaVersion: 1, projectName: 'fixture', checks });
export async function fixture(t, input = config()) {
  const project = await realpath(await mkdtemp(resolve(tmpdir(), 'peos-test-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  if (input) await saveConfig(project, input);
  return project;
}
export async function saveConfig(project, input) {
  await mkdir(resolve(project, '.project-os'), { recursive: true });
  await writeFile(resolve(project, '.project-os/engineering.config.json'), JSON.stringify(input));
}
export function cli(name, args, options = {}) {
  const result = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', timeout: 15000, ...options });
  assert.ifError(result.error);
  return result;
}
export function jsonCli(name, args, options = {}) {
  const result = cli(name, [...args, '--json'], options);
  assert.equal(result.stderr, '');
  return { ...result, report: JSON.parse(result.stdout) };
}
// Never read user/global Git config, run hooks, sign commits, or use user templates.
export function git(project, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-C', project, ...args], {
    encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
export async function repository(t) {
  const project = await fixture(t, null);
  git(project, 'init', '-b', 'main');
  await writeFile(resolve(project, 'base.txt'), 'base\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'fixture base');
  return project;
}
