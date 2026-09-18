import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repository, fixture, git, jsonCli, cli } from './helpers.mjs';
const changed = (project, mode = 'working-tree', extra = []) => jsonCli('check-changed-files.mjs', ['--project', project, '--mode', mode, ...extra]);

test('working tree preserves layers, deletions, renames, special paths and existing work', async t => {
  const project = await repository(t);
  for (const name of ['both.txt', 'delete.txt', 'old name.txt']) await writeFile(resolve(project, name), `baseline ${name}\n`);
  git(project, 'add', '.'); git(project, 'commit', '-m', 'baseline files');
  await writeFile(resolve(project, 'both.txt'), 'staged\n'); git(project, 'add', 'both.txt');
  await writeFile(resolve(project, 'both.txt'), 'unstaged\n');
  await unlink(resolve(project, 'delete.txt'));
  await rename(resolve(project, 'old name.txt'), resolve(project, 'new name.txt'));
  git(project, 'add', 'old name.txt', 'new name.txt');
  const special = ['untracked space.txt', 'tab\tname', 'line\nname', 'quote"name', '-leading', 'Türkçe.txt', '.env.local', 'package-lock.json'];
  for (const name of special) await writeFile(resolve(project, name), 'DO_NOT_REPORT_CONTENT\n');
  const before = git(project, 'status', '--porcelain=v1', '-z');
  const index = await readFile(resolve(project, '.git/index'));
  const result = changed(project);
  assert.equal(result.status, 0);
  const entries = result.report.changes;
  assert.deepEqual(entries.filter(r => r.path === 'both.txt').map(r => r.layer), ['staged', 'unstaged']);
  assert.ok(entries.some(r => r.status === 'D' && r.path === 'delete.txt'));
  assert.ok(entries.some(r => r.status.startsWith('R') && r.sourcePath === 'old name.txt' && r.path === 'new name.txt'));
  for (const path of special) assert.ok(entries.some(r => r.layer === 'untracked' && r.path === path), path);
  assert.deepEqual(entries.find(r => r.path === '.env.local').categories, ['potentially-sensitive']);
  assert.ok(entries.find(r => r.path === 'package-lock.json').categories.includes('dependency'));
  assert.ok(!result.stdout.includes('DO_NOT_REPORT_CONTENT'));
  assert.equal(git(project, 'status', '--porcelain=v1', '-z'), before);
  assert.deepEqual(await readFile(resolve(project, '.git/index')), index);
  assert.equal(await readFile(resolve(project, 'both.txt'), 'utf8'), 'unstaged\n');
  const human = cli('check-changed-files.mjs', ['--project', project, '--mode', 'working-tree']);
  assert.match(human.stdout, /line\\nname/);
});
test('merge-base on diverged branches excludes changes unique to the reference and local work', async t => {
  const project = await repository(t);
  git(project, 'checkout', '-b', 'topic');
  await writeFile(resolve(project, 'topic.txt'), 'topic\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'topic change');
  git(project, 'checkout', 'main');
  await writeFile(resolve(project, 'main-only.txt'), 'main\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'main change');
  git(project, 'checkout', 'topic');
  await writeFile(resolve(project, 'local.txt'), 'local\n');
  const result = changed(project, 'reference', ['--reference', 'main']);
  assert.equal(result.status, 0); assert.deepEqual(result.report.changes.map(r => r.path), ['topic.txt']);
  assert.match(git(project, 'diff', '--name-only', 'main', 'HEAD'), /main-only.txt/);
  assert.equal(result.report.localChanges.excluded, true); assert.equal(result.report.localChanges.present, true);
  assert.equal(result.report.localChanges.changes[0].path, 'local.txt');
  assert.equal(result.report.mergeBase, git(project, 'merge-base', 'main', 'HEAD').trim());
});
test('reference rename includes both paths and source categories', async t => {
  const project = await repository(t);
  await writeFile(resolve(project, '.env.example'), 'fixture data\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'source');
  const base = git(project, 'rev-parse', 'HEAD').trim();
  git(project, 'mv', '.env.example', 'safe name.txt'); git(project, 'commit', '-m', 'rename');
  const result = changed(project, 'reference', ['--reference', base]);
  assert.equal(result.report.changes[0].sourcePath, '.env.example');
  assert.ok(result.report.changes[0].categories.includes('potentially-sensitive'));
});
test('invalid references and unavailable merge base are errors without fallback', async t => {
  const project = await repository(t);
  assert.equal(changed(project, 'reference', ['--reference', 'no-such-ref']).report.error.code, 'REFERENCE');
  assert.equal(changed(project, 'reference', ['--reference', 'HEAD;touch injected']).report.error.code, 'REFERENCE');
  git(project, 'checkout', '--orphan', 'unrelated'); git(project, 'add', '.'); git(project, 'commit', '-m', 'unrelated root');
  const result = changed(project, 'reference', ['--reference', 'main']);
  assert.equal(result.status, 2); assert.equal(result.report.error.code, 'MERGE_BASE');
});
test('non-Git, unborn, subdirectory, invalid modes and missing inputs are rejected', async t => {
  const project = await fixture(t, null);
  assert.equal(changed(project).report.error.code, 'NOT_GIT');
  git(project, 'init', '-b', 'main'); assert.equal(changed(project).report.error.code, 'NO_HEAD');
  const repo = await repository(t); await mkdir(resolve(repo, 'nested'));
  assert.equal(changed(resolve(repo, 'nested')).report.error.code, 'NOT_GIT');
  for (const args of [[], ['--project', repo], ['--project', repo, '--mode', 'direct'], ['--project', repo, '--mode', 'reference'], ['--project', repo, '--mode', 'working-tree', '--reference', 'HEAD']]) {
    const result = jsonCli('check-changed-files.mjs', args);
    assert.equal(result.status, 2); assert.equal(result.report.status, 'ERROR');
  }
});
test('clean repository is a valid empty discovery result', async t => {
  const result = changed(await repository(t));
  assert.equal(result.status, 0); assert.deepEqual(result.report.changes, []); assert.equal(result.report.localChanges.present, false);
});
