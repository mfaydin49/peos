import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { check, config, git, jsonCli, repository, saveConfig, toolkit } from './helpers.mjs';
import { uiTriggersOf } from '../scripts/lib/changes.mjs';
import { readManifest } from '../scripts/lib/ui.mjs';
import { validateConfig } from '../scripts/lib/config.mjs';

const cliRun = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]).report;
const next = (project, name, extra = []) => cliRun(project, 'next', ['--run', name, ...extra]);
const fingerprint = project => cliRun(project, 'fingerprint').codeState;
const agentsOf = action => action.agents.map(entry => entry.agent);
const added = (path, ...lines) => ({ path, text: `diff --git a/${path} b/${path}\n+++ b/${path}\n${lines.map(line => `+${line}`).join('\n')}\n` });
async function report(dir, name, fields) {
  await writeFile(resolve(dir, `pending-eval-${name}.json`), JSON.stringify({ schemaVersion: 1, mode: 'full', criteria: [], findings: [], notAssessed: [], ...fields }));
}
// A tiny PNG header is enough: PEOS checks the file, the evaluator looks at it.
const png = 'Buffer.from("89504e470d0a1a0a", "hex")';
const capture = (manifest = '{ shots: [{ file: "list-empty.png", screen: "list", state: "empty", viewport: "phone", scheme: "dark" }] }') => check('ui', `
  const { writeFileSync } = require('node:fs'); const { join } = require('node:path');
  const dir = process.env.PEOS_UI_DIR; if (!dir) process.exit(3);
  writeFileSync(join(dir, 'list-empty.png'), ${png});
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(${manifest}));`, { kind: 'ui-capture', timeoutMs: 5000 });
async function smallRun(t, checks, extra = {}) {
  const project = await repository(t);
  await saveConfig(project, { ...config(checks), ...extra });
  // A project's configuration is committed; its check sources are not part of the change.
  git(project, 'add', '.'); git(project, 'commit', '-m', 'configuration');
  const { run: name, directory: dir } = cliRun(project, 'init', ['--name', 'list', '--type', 'feature', '--tier', 'small']);
  await writeFile(resolve(dir, 'task.md'), '# List\n## Acceptance criteria\n- AC-1: the empty list shows a create action\n## Plan\n- S1: list — files: index.html — covers: AC-1 — test: t\n');
  assert.deepEqual(agentsOf(next(project, name)), ['peos:implementer']);
  return { project, name, dir };
}
async function implemented(project, name, file = 'index.html', text = '<main><button>Create</button></main>\n') {
  await writeFile(resolve(project, file), text);
  const finish = next(project, name, ['--done', 'S1']);
  assert.deepEqual([finish.do, finish.command], ['run', 'finish']);
  return jsonCli('peos-run.mjs', ['finish', '--project', project, ...finish.args]).report;
}
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('UI triggers come from interface files and markup lines, never from tests, docs or plain logic', () => {
  assert.deepEqual(uiTriggersOf([added('src/page.html', '<p>hi</p>')]), ['markup']);
  assert.deepEqual(uiTriggersOf([added('src/List.tsx', 'return <ul className="list">{items}</ul>;')]), ['markup']);
  assert.deepEqual(uiTriggersOf([added('src/useItems.tsx', 'export const useItems = () => useState<Item[]>([]);', 'const ids: Array<string> = [];')]), [], 'a hook in a .tsx file is not markup');
  assert.deepEqual(uiTriggersOf([added('src/Row.tsx', '{open && <Row item={item}/>}')]), ['markup']);
  assert.deepEqual(uiTriggersOf([added('App/ListView.swift', 'struct ListView: View {')]), ['native-ui']);
  assert.deepEqual(uiTriggersOf([added('App/Store.swift', 'final class Store { var items: [Item] = [] }')]), []);
  assert.deepEqual(uiTriggersOf([added('app/src/main/res/layout/list.xml', '<LinearLayout/>'), added('app/Screen.kt', '@Composable fun Screen() {}')]), ['native-ui']);
  assert.deepEqual(uiTriggersOf([added('styles/site.css', 'a { color: red }'), added('src/theme.ts', 'export const accent = "#06c";')]), ['style']);
  assert.deepEqual(uiTriggersOf([added('App/Localizable.strings', '"create" = "Create";'), added('public/logo.svg', '<svg/>')]), ['assets', 'copy']);
  assert.deepEqual(uiTriggersOf([added('tests/page.test.tsx', 'render(<List/>)'), added('README.md', '<b>docs</b>'), added('__snapshots__/a.css', 'x')]), []);
});

test('a ui-capture manifest names image files inside its directory', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'peos-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await readManifest(dir)).status, 'missing');
  await writeFile(resolve(dir, 'a.png'), 'png');
  const write = manifest => writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
  await write({ shots: [{ file: 'a.png', screen: 'list', state: 'empty' }], a11y: [{ screen: 'list', rule: 'color-contrast', impact: 'serious' }] });
  const ok = await readManifest(dir);
  assert.deepEqual([ok.status, ok.shots, ok.screens, ok.a11y], ['captured', 1, ['list'], { serious: 1, critical: 0 }]);
  for (const [manifest, reason] of [
    [{ shots: [] }, /one to 60 shots/],
    [{ shots: [{ file: '../a.png', screen: 'list', state: 'empty' }] }, /directly inside/],
    [{ shots: [{ file: 'b.png', screen: 'list', state: 'empty' }] }, /missing/],
    [{ shots: [{ file: 'a.png', screen: 'list' }] }, /screen and state/],
    [{ shots: [{ file: 'a.png', screen: 'list', state: 'empty' }], a11y: [{ screen: 'list', rule: 'x', impact: 'bad' }] }, /impact/],
    [{ shots: [{ file: 'a.png', screen: 'list', state: 'empty' }], extra: 1 }, /unknown field/]
  ]) {
    await write(manifest);
    const result = await readManifest(dir);
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, reason);
  }
});

test('the configuration accepts a ui-capture check and a loopback preview only', () => {
  const base = config([check('ui', '', { kind: 'ui-capture' })]);
  const preview = url => ({ ...base, preview: { executable: 'npm', args: ['run', 'dev'], url, timeoutMs: 1000 } });
  for (const url of ['http://localhost:5173', 'http://127.0.0.1:3000/', 'http://[::1]:8080', 'http://app.localhost']) assert.ok(validateConfig(preview(url)).preview);
  for (const url of ['https://example.com', 'http://localhost:5173/app', 'http://10.0.0.2:80', 'file:///tmp/x']) assert.throws(() => validateConfig(preview(url)), /preview\.url/);
  const filled = validateConfig(preview('http://localhost:5173/')).preview;
  assert.deepEqual([filled.url, filled.readyPath, filled.viewports.length, filled.colorSchemes], ['http://localhost:5173', '/', 2, ['light', 'dark']]);
});

test('a UI change with captured screenshots gets eval-ui beside eval-code, and the summary links them', async t => {
  const { project, name, dir } = await smallRun(t, [check(), capture()]);
  const finished = await implemented(project, name);
  assert.deepEqual([finished.checks, finished.uiTriggers], ['PASS', ['markup']]);
  const recorded = JSON.parse(await readFile(resolve(dir, 'checks.json'), 'utf8'));
  assert.deepEqual([recorded.ui.status, recorded.ui.shots], ['captured', 1]);
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate).sort(), ['peos:eval-code', 'peos:eval-ui']);
  const ui = evaluate.agents.find(entry => entry.agent === 'peos:eval-ui').inputs;
  assert.deepEqual([ui.screenshots, ui.triggers, ui.report], [resolve(dir, 'ui/manifest.json'), ['markup'], resolve(dir, 'pending-eval-ui.json')]);
  assert.equal(ui.preview, undefined);
  const subject = fingerprint(project);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject });
  await report(dir, 'ui', { evaluator: 'ui', verdict: 'FAIL', subject, findings: [{ id: 'F1', severity: 'high', problem: 'list, empty, phone, dark: the create button is black on black', impact: 'nobody finds it', fix: 'use the accent token' }] });
  const fix = next(project, name);
  assert.deepEqual(agentsOf(fix), ['peos:implementer']);
  assert.equal(fix.agents[0].inputs.findings[0].evaluation, 'ui');
  await writeFile(resolve(project, 'index.html'), '<main><button class="accent">Create</button></main>\n');
  const again = next(project, name);
  assert.equal(jsonCli('peos-run.mjs', ['finish', '--project', project, ...again.args]).report.checks, 'PASS');
  const second = next(project, name);
  assert.deepEqual(agentsOf(second).sort(), ['peos:eval-code', 'peos:eval-ui']);
  const again2 = second.agents.find(entry => entry.agent === 'peos:eval-ui').inputs;
  assert.ok(again2['previous blocking findings'].length);
  await report(dir, 'ui', { evaluator: 'ui', verdict: 'PASS', subject: fingerprint(project) });
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  const summary = next(project, name);
  assert.equal(summary.do, 'write');
  assert.deepEqual(summary.sources.ui, { evaluation: resolve(dir, 'evals/ui.json'), screenshots: resolve(dir, 'ui/manifest.json') });
  assert.match(summary.message, /user interface observed/);
});

test('a capture that passes without usable screenshots fails the checks', async t => {
  const { project, name, dir } = await smallRun(t, [check(), capture('{ shots: [{ file: "other.png", screen: "list", state: "empty" }] }')]);
  const finished = await implemented(project, name);
  assert.deepEqual([finished.checks, finished.failed], ['FAIL', ['ui']]);
  const recorded = JSON.parse(await readFile(resolve(dir, 'checks.json'), 'utf8'));
  assert.equal(recorded.ui.status, 'invalid');
  assert.match(recorded.checks.find(entry => entry.id === 'ui').reason, /other\.png is missing/);
  assert.deepEqual(agentsOf(next(project, name)), ['peos:implementer']);
});

test('a UI change nothing can show is not evaluated, and the summary says it was not verified', async t => {
  const { project, name, dir } = await smallRun(t, [check()]);
  await implemented(project, name);
  const evaluate = next(project, name);
  assert.deepEqual(agentsOf(evaluate), ['peos:eval-code']);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  const summary = next(project, name);
  assert.equal(summary.do, 'write');
  assert.deepEqual(summary.sources.ui.triggers, ['markup']);
  assert.match(summary.sources.ui['not verified'], /no ui-capture check or preview is configured/);
  assert.match(summary.message, /not verified, first under Not verified/);
});

test('a change without interface gets no UI evaluation and no UI summary line', async t => {
  const { project, name, dir } = await smallRun(t, [check(), capture()]);
  await implemented(project, name, 'list.js', 'export const list = [];\n');
  assert.deepEqual(agentsOf(next(project, name)), ['peos:eval-code']);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject: fingerprint(project) });
  assert.equal(next(project, name).sources.ui, undefined);
});

test('a configured preview is started by peos-run for eval-ui and stopped at release', async t => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1')`;
  const { project, name, dir } = await smallRun(t, [check()], { preview: { executable: process.execPath, args: ['-e', server], url, timeoutMs: 10000 } });
  t.after(() => jsonCli('peos-run.mjs', ['preview-stop', '--project', project, '--run', name]));
  await implemented(project, name);
  const start = next(project, name);
  assert.deepEqual([start.do, start.command, start.args], ['run', 'preview-start', ['--run', name]]);
  const started = cliRun(project, 'preview-start', start.args);
  assert.deepEqual([started.url, started.reused], [url, false]);
  assert.equal(cliRun(project, 'preview-start', start.args).reused, true);
  const evaluate = next(project, name);
  const ui = evaluate.agents.find(entry => entry.agent === 'peos:eval-ui').inputs;
  assert.deepEqual([ui.preview, ui.viewports, ui['color schemes'], ui.screenshots], [url, ['mobile 390x844', 'desktop 1280x800'], ['light', 'dark'], undefined]);
  const subject = fingerprint(project);
  await report(dir, 'code-all', { evaluator: 'code', focus: 'all', verdict: 'PASS', subject });
  await report(dir, 'ui', { evaluator: 'ui', verdict: 'PASS', subject });
  const { pid } = JSON.parse(await readFile(resolve(dir, 'preview.json'), 'utf8'));
  assert.equal(next(project, name).do, 'write');
  assert.equal(alive(pid), false, 'the release stage stopped the preview');
  assert.equal(await readFile(resolve(dir, 'preview.json'), 'utf8').catch(() => null), null);
});

test('a preview command that starts its server in the background and exits still counts, and stop ends the server', async t => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // The command spawns the server into its own process group and exits at once.
  const wrapper = `require('node:child_process').spawn(process.execPath, ['-e', "require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1')"], { stdio: 'ignore' }).unref()`;
  const { project, name, dir } = await smallRun(t, [check()], { preview: { executable: process.execPath, args: ['-e', wrapper], url, timeoutMs: 10000 } });
  t.after(() => jsonCli('peos-run.mjs', ['preview-stop', '--project', project, '--run', name]));
  await implemented(project, name);
  assert.equal(cliRun(project, 'preview-start', ['--run', name]).reused, false);
  assert.ok((await readFile(resolve(dir, '.gitignore'), 'utf8')).split('\n').includes('preview.json'));
  const evaluate = next(project, name);
  assert.ok(agentsOf(evaluate).includes('peos:eval-ui'), 'the server still runs after its launcher exited');
  assert.equal(cliRun(project, 'preview-stop', ['--run', name]).stopped, true);
  const probe = spawnSync(process.execPath, ['-e', `fetch('${url}').then(() => process.exit(0), () => process.exit(1))`]);
  assert.equal(probe.status, 1, 'the server is gone');
});

test('checks that run no capture keep the screenshots of the code they describe', async t => {
  const { project, name, dir } = await smallRun(t, [check(), capture()]);
  await implemented(project, name);
  cliRun(project, 'record-checks', ['--run', name, '--phase', 'task', '--checks', '["test"]']);
  assert.equal(await readFile(resolve(dir, 'ui/manifest.json'), 'utf8').then(() => true), true);
});

test('a preview is not used when its port already answers for something else', async t => {
  const port = await freePort();
  // Another local server, in its own process: the CLI calls below block this one.
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => other.kill());
  await new Promise(done => other.stdout.once('data', done));
  const { project, name } = await smallRun(t, [check()], { preview: { executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], url: `http://127.0.0.1:${port}`, timeoutMs: 2000 } });
  await implemented(project, name);
  const refused = jsonCli('peos-run.mjs', ['preview-start', '--project', project, '--run', name]).report;
  assert.equal(refused.error.code, 'PREVIEW');
  assert.match(refused.error.message, /did not start it/);
});

test('state-guard gives MCP tools only to eval-ui, only browser tools, only on the run preview', async t => {
  const { project, name, dir } = await smallRun(t, [check()]);
  // A running preview of this run: the test process's own group stands in for the server.
  const leader = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
  const leaderStart = spawnSync('ps', ['-o', 'lstart=', '-p', String(leader)], { encoding: 'utf8' }).stdout.trim() || null;
  await writeFile(resolve(dir, 'preview.json'), JSON.stringify({ pid: leader, leaderStart, url: 'http://localhost:5173' }));
  const guard = (agent, tool, toolInput = {}) => {
    const result = spawnSync(process.execPath, [resolve(toolkit, 'hooks/state-guard.mjs')], {
      input: JSON.stringify({ cwd: project, tool_name: tool, tool_input: toolInput, ...(agent ? { agent_type: agent } : {}) }), encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'http://localhost:5173/list?state=empty' }), 'allow');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__computer', { action: 'screenshot' }), 'allow');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'localhost:5173/' }), 'allow');
  // The design evaluator looks at the served design preview under the same limits.
  assert.equal(guard('peos:eval-design', 'mcp__Claude_Browser__navigate', { url: 'http://localhost:5173/' }), 'allow');
  assert.equal(guard('peos:eval-design', 'mcp__Claude_Browser__resize_window', { width: 390, height: 844 }), 'allow');
  assert.equal(guard('peos:eval-design', 'mcp__Claude_Browser__read_console_messages', {}), 'allow');
  assert.equal(guard('peos:eval-design', 'mcp__Claude_Browser__navigate', { url: 'https://example.com' }), 'deny');
  assert.equal(guard('peos:eval-design', 'mcp__Claude_Browser__javascript_tool', { text: 'x' }), 'deny');
  assert.equal(guard('peos:eval-plan', 'mcp__Claude_Browser__navigate', { url: 'http://localhost:5173/' }), 'deny', 'no other agent browses');
  assert.equal(guard('peos:eval-ui', 'mcp__playwright__browser_take_screenshot', {}), 'allow');
  assert.equal(guard('peos:eval-ui', 'mcp__claude-in-chrome__read_page', { tabId: 1 }), 'deny', 'the user\'s own Chrome is never used');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__computer', { action: 'type', text: 'x' }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__playwright__browser_run_code', { code: 'x' }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__playwright__browser_fill_form', {}), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__browser_batch', { actions: [{ name: 'javascript_tool', input: { text: 'fetch(1)' } }] }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__browser_batch', { actions: [{ name: 'navigate', input: { url: 'http://localhost:5173/a' } }, { name: 'computer', input: { action: 'screenshot' } }] }), 'allow');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'back' }), 'allow');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'https://example.com' }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'http://localhost:3000' }), 'deny', 'another local port');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://example.com' } }] }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__javascript_tool', { text: 'location.href' }), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__playwright__browser_file_upload', {}), 'deny');
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Code_iOS_Simulator__control', { action: 'screenshot' }), 'deny');
  assert.equal(guard('peos:eval-code', 'mcp__Claude_Browser__computer', { action: 'screenshot' }), 'deny');
  assert.equal(guard(null, 'mcp__Claude_Browser__navigate', { url: 'https://example.com' }), 'allow', 'the user and the orchestrator are not limited');
  assert.equal(guard('peos:implementer', 'mcp__Claude_Code_iOS_Simulator__control', { action: 'screenshot' }), 'allow');
  assert.equal(guard('peos:eval-ui', 'Write', { file_path: resolve(dir, 'pending-eval-ui.json') }), 'allow');
  assert.equal(guard('peos:eval-ui', 'Write', { file_path: resolve(dir, 'pending-eval-code-all.json') }), 'deny');
  // A preview that is no longer running opens nothing.
  await writeFile(resolve(dir, 'preview.json'), JSON.stringify({ pid: leader, leaderStart: 'another start', url: 'http://localhost:5173' }));
  assert.equal(guard('peos:eval-ui', 'mcp__Claude_Browser__navigate', { url: 'http://localhost:5173/' }), 'deny');
});
