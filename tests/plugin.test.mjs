import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { toolkit } from './helpers.mjs';
import { runActions } from '../scripts/lib/run-actions.mjs';

const json = async path => JSON.parse(await readFile(resolve(toolkit, path), 'utf8'));
// Minimal frontmatter reader: the plugin files use flat "key: value" lines only.
async function document(path) {
  const source = await readFile(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, `${path} needs frontmatter`);
  const fields = Object.fromEntries(match[1].split('\n').map(line => {
    const [, key, value] = /^([\w-]+):\s*(.*)$/.exec(line) ?? assert.fail(`${path}: unsupported frontmatter line ${line}`);
    return [key, value.replace(/^"(.*)"$/, '$1')];
  }));
  return { fields, body: match[2], source };
}
const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
const agentFiles = (await readdir(resolve(toolkit, 'agents'))).filter(name => name.endsWith('.md'));
const skillNames = (await readdir(resolve(toolkit, 'skills'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
const pluginFiles = [...agentFiles.map(name => resolve(toolkit, 'agents', name)), ...skillNames.map(name => resolve(toolkit, 'skills', name, 'SKILL.md'))];

test('plugin and marketplace manifests agree with the package', async () => {
  const plugin = await json('.claude-plugin/plugin.json');
  const marketplace = await json('.claude-plugin/marketplace.json');
  const pkg = await json('package.json');
  assert.equal(plugin.name, 'peos');
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(marketplace.plugins.map(entry => [entry.name, entry.source]), [['peos', './']]);
});

test('agents are named after their file, cannot delegate, and only the implementer writes or runs commands', async () => {
  assert.deepEqual(agentFiles.sort(), ['eval-code.md', 'eval-plan.md', 'eval-security.md', 'eval-spec.md', 'implementer.md', 'planner.md', 'spec-writer.md']);
  for (const name of agentFiles) {
    const { fields } = await document(resolve(toolkit, 'agents', name));
    assert.equal(fields.name, name.replace(/\.md$/, ''));
    assert.ok(fields.description && fields.model, `${name}: description and model`);
    assert.ok(list(fields.disallowedTools).includes('Agent'), `${name}: no nested delegation`);
    const tools = list(fields.tools);
    assert.ok(!tools.includes('Agent'), `${name}: Agent`);
    if (name === 'implementer.md') { assert.deepEqual(tools.sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']); continue; }
    // Producers and evaluators return content to the orchestrator; only it writes run files.
    for (const forbidden of ['Edit', 'Write', 'NotebookEdit', 'Bash']) assert.ok(!tools.includes(forbidden), `${name}: ${forbidden}`);
  }
});

test('skills are named after their directory and gate decisions are user-only', async () => {
  for (const name of skillNames) {
    const { fields } = await document(resolve(toolkit, 'skills', name, 'SKILL.md'));
    assert.equal(fields.name, name);
    assert.ok(fields.description, `${name}: description`);
  }
  for (const name of ['start', 'continue', 'approve', 'revise', 'retry']) {
    assert.equal((await document(resolve(toolkit, 'skills', name, 'SKILL.md'))).fields['disable-model-invocation'], 'true', name);
  }
  assert.equal((await document(resolve(toolkit, 'skills/orchestrator/SKILL.md'))).fields['user-invocable'], 'false');
});

test('plugin paths, Markdown links and peos-run commands referenced by plugin files exist', async () => {
  let commands = 0;
  for (const path of pluginFiles) {
    const { source } = await document(path);
    for (const [, target] of source.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`"')]+)/g)) {
      await access(resolve(toolkit, target.replace(/[.,:;]$/, '')));
    }
    // Bare toolkit paths such as templates/run/spec.md are also relative to the plugin root.
    for (const [target] of source.matchAll(/\b(?:templates|rules|schemas|scripts)\/[\w./-]*\w/g)) await access(resolve(toolkit, target));
    for (const [, target] of source.matchAll(/\]\(((?!https?:|#)[^)#]+)(?:#[^)]*)?\)/g)) await access(resolve(dirname(path), target));
    // Each command runs to the end of its code span or line; every option must exist for that action.
    for (const [, action, rest] of source.matchAll(/peos-run(?:\.mjs")? ([a-z][a-z-]+)([^`\n]*)/g)) {
      assert.ok(Object.hasOwn(runActions, action), `${path}: unknown peos-run action ${action}`);
      for (const [, option] of rest.matchAll(/--([a-z][a-z-]*)/g)) {
        assert.ok([...runActions[action], 'json'].includes(option), `${path}: ${action} has no --${option}`);
      }
      commands++;
    }
  }
  assert.ok(commands >= 10, 'commands were found and checked');
  for (const agent of agentFiles.map(name => name.replace(/\.md$/, ''))) {
    assert.match(await readFile(resolve(toolkit, 'skills/orchestrator/SKILL.md'), 'utf8'), new RegExp(`peos:${agent}`));
  }
});

test('hooks reference existing scripts and guard every write tool', async () => {
  const { hooks } = await json('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const entries of Object.values(hooks)) for (const entry of entries) for (const { type, command } of entry.hooks) {
    assert.equal(type, 'command');
    const [, script] = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)"$/.exec(command) ?? assert.fail(command);
    await access(resolve(toolkit, script));
  }
  assert.deepEqual(hooks.PreToolUse[0].matcher.split('|').sort(), ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  const plugin = await json('.claude-plugin/plugin.json');
  assert.equal(plugin.userConfig.hook_profile.default, 'standard');
});
