import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink, realpath, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, jsonCli, toolkit } from './helpers.mjs';
const names = ['peos-task-planning', 'peos-implementation', 'peos-code-review', 'peos-release-check'];
const setup = project => jsonCli('setup-codex.mjs', ['--project', project]);
test('setup connects discovery paths, preserves work and is idempotent', async t => {
  const project = await fixture(t);
  const original = '# Project rules\r\n\r\nPreserve this exact guidance.\r\n';
  await writeFile(resolve(project, 'AGENTS.md'), original);
  await writeFile(resolve(project, 'work.txt'), 'user changes');
  await mkdir(resolve(project, '.agents/skills/other-skill'), { recursive: true });
  await writeFile(resolve(project, '.agents/skills/other-skill/SKILL.md'), 'unrelated skill');
  const originalConfig = await readFile(resolve(project, '.project-os/engineering.config.json'));
  const first = setup(project);
  assert.equal(first.status, 0); assert.equal(first.report.linksCreated, 5);
  const after = await readFile(resolve(project, 'AGENTS.md'), 'utf8'); assert.ok(after.startsWith(original));
  assert.equal(await realpath(resolve(project, '.project-os/toolkit')), await realpath(toolkit));
  for (const name of names) {
    const body = await readFile(resolve(project, '.agents/skills', name, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    assert.equal(await realpath(resolve(project, '.agents/skills', name)), await realpath(resolve(toolkit, 'skills', name)));
  }
  const second = setup(project);
  assert.equal(second.status, 0); assert.equal(second.report.linksCreated, 0); assert.equal(second.report.instructionsAppended, false);
  assert.equal(await readFile(resolve(project, 'AGENTS.md'), 'utf8'), after);
  assert.deepEqual(await readFile(resolve(project, '.project-os/engineering.config.json')), originalConfig);
  assert.equal(await readFile(resolve(project, 'work.txt'), 'utf8'), 'user changes');
  assert.equal(await readFile(resolve(project, '.agents/skills/other-skill/SKILL.md'), 'utf8'), 'unrelated skill');
});
test('collisions are detected before appending instructions or creating links', async t => {
  const project = await fixture(t);
  await writeFile(resolve(project, 'AGENTS.md'), 'Existing');
  await mkdir(resolve(project, '.agents/skills/peos-implementation'), { recursive: true });
  await writeFile(resolve(project, '.agents/skills/peos-implementation/SKILL.md'), 'existing');
  assert.equal(setup(project).status, 2); assert.equal(await readFile(resolve(project, 'AGENTS.md'), 'utf8'), 'Existing');
  await assert.rejects(access(resolve(project, '.project-os/toolkit')));
});
test('setup rejects overrides, edited sections, symlinked parents and symlinked AGENTS', async t => {
  for (const kind of ['override', 'section', 'parent', 'agents']) {
    const project = await fixture(t); const outside = await fixture(t, null);
    if (kind === 'override') await writeFile(resolve(project, 'AGENTS.override.md'), 'active');
    if (kind === 'section') await writeFile(resolve(project, 'AGENTS.md'), '<!-- personal-engineering-os:start -->\nedited');
    if (kind === 'parent') await symlink(outside, resolve(project, '.agents'));
    if (kind === 'agents') { await writeFile(resolve(outside, 'rules'), 'untouched'); await symlink(resolve(outside, 'rules'), resolve(project, 'AGENTS.md')); }
    assert.equal(setup(project).status, 2, kind); await assert.rejects(access(resolve(project, '.project-os/toolkit')));
    if (kind === 'agents') assert.equal(await readFile(resolve(outside, 'rules'), 'utf8'), 'untouched');
  }
});
test('setup requires config and creates AGENTS when absent', async t => {
  const missing = await fixture(t, null);
  assert.equal(setup(missing).report.error.code, 'CONFIG_MISSING'); await assert.rejects(access(resolve(missing, 'AGENTS.md')));
  const project = await fixture(t); assert.equal(setup(project).status, 0);
  assert.match(await readFile(resolve(project, 'AGENTS.md'), 'utf8'), /personal-engineering-os:start/);
});
