import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config, jsonCli, plainEnv, repository, saveConfig, toolkit } from './helpers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const run = (project, action, args = []) => jsonCli('peos-run.mjs', [action, '--project', project, ...args]).report;
function hook(name, project, input, profile = 'standard') {
  const result = spawnSync(process.execPath, [resolve(toolkit, 'hooks', `${name}.mjs`)], {
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: project, ...input }), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_OPTION_HOOK_PROFILE: profile }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
async function standardRun(t) {
  const project = await repository(t);
  await saveConfig(project, config());
  const { run: name, directory } = run(project, 'init', ['--name', 'avatar', '--type', 'feature', '--tier', 'standard']);
  return { project, name, directory };
}
async function evaluatedSpec(project, name, directory, text = 'spec') {
  await writeFile(resolve(directory, 'spec.md'), text);
  const input = JSON.stringify({ schemaVersion: 1, evaluator: 'spec', verdict: 'PASS', mode: 'full', subject: `sha256:${sha(text)}`, criteria: [], findings: [], notAssessed: [] });
  assert.equal(jsonCli('peos-run.mjs', ['record-eval', '--project', project, '--run', name, '--report', '-'], { input }).report.status, 'PASS');
}
const decision = report => report.error?.code ?? report.status;

test('decisions need a matching, fresh grant and consume it on every attempt', async t => {
  const { project, name, directory } = await standardRun(t);
  await evaluatedSpec(project, name, directory);
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'spec']).error.message, /No pending user decision/);
  run(project, 'grant', ['--action', 'approve', '--target', 'plan']);
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'spec']).error.message, /is "approve plan"/);
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'spec']).error.message, /No pending user decision/, 'a refused attempt consumed the grant');
  const grantFile = resolve(project, '.project-os/runs/.grant.json');
  run(project, 'grant', ['--action', 'approve', '--target', 'spec']);
  const stale = JSON.parse(await readFile(grantFile, 'utf8'));
  await writeFile(grantFile, JSON.stringify({ ...stale, at: new Date(Date.now() - 16 * 60 * 1000).toISOString() }));
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'spec']).error.message, /expired/);
  run(project, 'init', ['--name', 'other', '--type', 'fix', '--tier', 'standard']);
  run(project, 'grant', ['--action', 'approve', '--target', 'spec', '--run', 'other']);
  assert.match(run(project, 'approve', ['--run', name, '--gate', 'spec']).error.message, /names run .*-other/);
  run(project, 'grant', ['--action', 'approve', '--target', 'spec', '--run', 'avatar']);
  assert.equal(decision(run(project, 'approve', ['--run', name, '--gate', 'spec'])), 'PASS');
  assert.equal(decision(run(project, 'revise', ['--run', name, '--gate', 'spec'])), 'GRANT');
});

test('approval-capture turns only a whole decision command into a grant', async t => {
  const { project, name, directory } = await standardRun(t);
  const grantFile = resolve(project, '.project-os/runs/.grant.json');
  const grant = async () => JSON.parse(await readFile(grantFile, 'utf8').catch(() => 'null'));
  for (const prompt of ['please /peos:approve spec', '/peos:approve spec now', '/peos:approve deploy', 'Approve the spec']) {
    assert.equal(hook('approval-capture', project, { prompt }), null);
    assert.equal(await grant(), null, prompt);
  }
  hook('approval-capture', project, { prompt: '/peos:revise plan --run avatar Move CLI tests to their own file.' });
  assert.deepEqual([(await grant()).action, (await grant()).target, (await grant()).run], ['revise', 'plan', name]);
  hook('approval-capture', project, { prompt: '/peos:retry code-all' });
  assert.deepEqual([(await grant()).action, (await grant()).target, (await grant()).run], ['reset-eval', 'code-all', name], 'bound to the active run');
  hook('approval-capture', project, { prompt: '  /peos:approve spec  ' });
  assert.equal((await grant()).source, 'user-prompt');
  await evaluatedSpec(project, name, directory);
  assert.equal(decision(run(project, 'approve', ['--run', name, '--gate', 'spec'])), 'PASS');
  assert.equal(hook('approval-capture', project, 'not json'), null);
});

test('state-guard denies writes to run state, evidence and decisions, and allows artifacts', async t => {
  const { project, directory } = await standardRun(t);
  const denied = output => output?.hookSpecificOutput?.permissionDecision === 'deny';
  const write = file_path => hook('state-guard', project, { tool_name: 'Write', tool_input: { file_path, content: '{}' } });
  for (const path of ['state.json', 'checks.json', 'evals/spec.json', 'state.lock', 'state.json.tmp-1-ab']) assert.ok(denied(write(resolve(directory, path))), path);
  assert.ok(denied(write(resolve(project, '.project-os/runs/.grant.json'))));
  assert.ok(denied(hook('state-guard', project, { tool_name: 'Edit', cwd: directory, tool_input: { file_path: 'state.json' } })), 'relative path');
  for (const path of ['spec.md', 'plan.md', 'pending-eval.json']) assert.equal(write(resolve(directory, path)), null, path);
  assert.equal(write(resolve(project, 'src/state.json')), null, 'outside runs');
  const bash = command => hook('state-guard', project, { tool_name: 'Bash', tool_input: { command } });
  const script = resolve(toolkit, 'scripts/peos-run.mjs');
  for (const command of [`node "${script}" grant --project "${project}" --action approve --target spec`,
    `echo {} > ${project}/.project-os/runs/.grant.json`, `cat ${directory}/state.json`,
    `node "${script}" status --project "${project}" > ${directory}/checks.json`]) assert.ok(denied(bash(command)), command);
  for (const command of [`node "${script}" status --project "${project}" --run avatar --json`,
    `node "${script}" record-eval --project "${project}" --run avatar --report "${directory}/pending-eval.json" --json`, 'npm test']) assert.equal(bash(command), null, command);
  assert.ok(denied(hook('state-guard', project, { agent_type: 'peos:eval-spec', tool_name: 'Bash', tool_input: { command: 'ls' } })));
  assert.ok(denied(hook('state-guard', project, { agent_type: 'peos:planner', tool_name: 'Write', tool_input: { file_path: resolve(project, 'x') } })));
  assert.equal(hook('state-guard', project, { agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.ok(denied(hook('state-guard', project, '{"tool_input": ".grant.json"')), 'unreadable call naming PEOS state');
});

test('gate-stop blocks once for an unevaluated fresh artifact and respects profiles', async t => {
  const { project, name, directory } = await standardRun(t);
  run(project, 'advance', ['--run', name, '--to', 'spec']);
  const transcript_path = resolve(project, 'transcript.jsonl');
  await writeFile(transcript_path, `{"tool":"peos-run init","run":"${name}"}\n`);
  const unrelated = resolve(project, 'other-session.jsonl');
  await writeFile(unrelated, '{"text":"unrelated work"}\n');
  assert.equal(hook('gate-stop', project, { transcript_path }), null, 'no artifact yet');
  await writeFile(resolve(directory, 'spec.md'), 'draft');
  assert.equal(hook('gate-stop', project, { transcript_path }, 'minimal'), null);
  assert.equal(hook('gate-stop', project, { transcript_path, stop_hook_active: true }), null);
  assert.equal(hook('gate-stop', project, { transcript_path: unrelated }), null, 'another session is left alone');
  assert.equal(hook('gate-stop', project, {}), null, 'no transcript, no block');
  assert.equal(hook('gate-stop', project, { transcript_path }).decision, 'block');
  assert.equal(hook('gate-stop', project, { transcript_path }), null, 'blocks at most once per artifact version');
  await evaluatedSpec(project, name, directory, 'draft v2');
  assert.equal(hook('gate-stop', project, { transcript_path }), null, 'evaluated artifact');
});

test('session-resume summarizes unfinished runs unless minimal', async t => {
  const { project, name } = await standardRun(t);
  const output = hook('session-resume', project, { source: 'startup' });
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`${name} \\(feature/standard\\) at intake; next gate: spec`));
  assert.equal(hook('session-resume', project, {}, 'minimal'), null);
  const empty = await repository(t);
  assert.equal(hook('session-resume', empty, {}), null);
});

test('state-guard closes case, quoting, working-directory and indirection gaps found in review', async t => {
  const { project, name, directory } = await standardRun(t);
  const denied = output => output?.hookSpecificOutput?.permissionDecision === 'deny';
  const write = (file_path, cwd) => hook('state-guard', project, { tool_name: 'Write', ...(cwd ? { cwd } : {}), tool_input: { file_path, content: '{}' } });
  for (const path of [resolve(directory, 'STATE.JSON'), resolve(project, '.project-os/runs/.Grant.json'), resolve(directory, 'notes.md'),
    resolve(project, '.project-os/runs/2026-01-01-forged/state.json'), resolve(project, '.project-os/./runs', name, 'state.json'),
    resolve(project, '.project-os/runs/x.md')]) assert.ok(denied(write(path)), path);
  assert.equal(write(resolve(directory, 'SPEC.md')), null, 'artifact names are case-insensitive');
  // A symlink is judged by its target: an artifact name pointing at state.json is a state write.
  await symlink(resolve(directory, 'state.json'), resolve(directory, 'plan.md'));
  assert.ok(denied(write(resolve(directory, 'plan.md'))), 'artifact symlinked to state');
  const bash = (command, cwd) => hook('state-guard', project, { tool_name: 'Bash', ...(cwd ? { cwd } : {}), tool_input: { command } });
  const script = resolve(toolkit, 'scripts/peos-run.mjs');
  for (const [command, cwd] of [[`node '${script}' grant --project ${project} --action approve --target spec`],
    [`node "${script}" 'grant' --project ${project} --action approve --target spec`],
    ["sed -i '' s/pending/approved/ state.json", directory], ['cp /tmp/forged.json x.json', resolve(project, '.project-os')],
    [`cat x > ${project}/.project-os/./runs/${name}/state.json`], [`cp -r /tmp/run ${project}/.PROJECT-OS/runs/`],
    [`node /tmp/peos-run.mjs advance --project ${project} --report ${directory}/pending-eval.json`],
    [`node "${script}" status --project "${project}" & node "${script}" status --project "${project}" --run ${directory}`]]) {
    assert.ok(denied(bash(command, cwd)), command);
  }
  assert.equal(bash(`node '${script}' record-eval --project '${project}' --run ${name} --report '${directory}/pending-eval.json'`), null, 'single-quoted plain call');
  assert.equal(bash('npm test', project), null);
});

test('grants are claimed by exactly one consumer and only user-prompt grants count inside Claude Code', async t => {
  const { project, name, directory } = await standardRun(t);
  const other = run(project, 'init', ['--name', 'other', '--type', 'fix', '--tier', 'standard']);
  await evaluatedSpec(project, name, directory);
  await evaluatedSpec(project, other.run, other.directory);
  for (let trial = 0; trial < 5; trial++) {
    run(project, 'grant', ['--action', 'revise', '--target', 'spec']);
    const env = plainEnv();
    const consumers = [name, other.run].map(runName => new Promise(done => {
      const child = spawn(process.execPath, [resolve(toolkit, 'scripts/peos-run.mjs'), 'revise', '--project', project, '--run', runName, '--gate', 'spec', '--json'], { env });
      let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.on('close', () => done(JSON.parse(out).status));
    }));
    assert.equal((await Promise.all(consumers)).filter(status => status === 'PASS').length, 1, `trial ${trial}`);
  }
  const inside = { env: { CLAUDECODE: '1' } };
  assert.equal(jsonCli('peos-run.mjs', ['grant', '--project', project, '--action', 'approve', '--target', 'spec'], inside).report.error.code, 'GRANT');
  run(project, 'grant', ['--action', 'revise', '--target', 'spec', '--run', name]);
  assert.match(jsonCli('peos-run.mjs', ['revise', '--project', project, '--run', name, '--gate', 'spec'], inside).report.error.message, /typed by the user/);
  hook('approval-capture', project, { prompt: `/peos:revise spec --run ${name.slice(11)} tighten AC-2` });
  assert.equal(jsonCli('peos-run.mjs', ['revise', '--project', project, '--run', name, '--gate', 'spec'], inside).report.status, 'PASS');
});

test('state-guard refuses expansion inside quotes, globs, find, environment changes and renamed grant scripts', async t => {
  const { project, name, directory } = await standardRun(t);
  const denied = output => output?.hookSpecificOutput?.permissionDecision === 'deny';
  const bash = command => hook('state-guard', project, { tool_name: 'Bash', tool_input: { command } });
  const script = resolve(toolkit, 'scripts/peos-run.mjs');
  for (const command of [
    `node "${script}" status --project "$(cp /tmp/x .project-os/runs/${name}/state.json)" --json`,
    `node "${script}" status --project "\`touch .project-os/runs/${name}/state.json\`"`,
    'cp /tmp/x .proj*/runs/*/state.json', "find . -name state.json -path '*runs*' -exec cp /tmp/x {} +",
    'find . -name state.json -exec cp /tmp/x {} +',
    `CLAUDECODE= node "${script}" approve --project "${project}" --run ${name} --gate spec`,
    `env -u CLAUDECODE node "${script}" approve --project "${project}"`,
    `env - /usr/local/bin/node "${script}" approve --project "${project}"`, `env --ignore-environment node "${script}" status`,
    `node "${resolve(toolkit, 'scripts/r.mjs')}" grant --project "${project}" --action approve --target spec`,
    `git add "$(cp /tmp/x .proj*/runs/*/sta*)"`, `git add .project-os/runs/${name}/state.json`, `git checkout -- .project-os/runs/${name}`,
    `ls ${directory}/evals`
  ]) assert.ok(denied(bash(command)), command);
  for (const command of [`git add .project-os/runs/${name}/spec.md .project-os/runs/${name}/plan.md`, `git diff -- .project-os/runs/${name}/spec.md`,
    'git status', 'npm run evals', 'ls src/*.js', `node '${script}' status --project '${project}' --run ${name} --checks '["tests"]'`]) assert.equal(bash(command), null, command);
});

test('the implementer writes project code but never PEOS state or peos-run', async t => {
  const { project, directory } = await standardRun(t);
  const denied = output => output?.hookSpecificOutput?.permissionDecision === 'deny';
  const as = (tool_name, tool_input) => hook('state-guard', project, { agent_type: 'peos:implementer', tool_name, tool_input });
  assert.equal(as('Write', { file_path: resolve(project, 'src/todo.js'), content: '' }), null);
  assert.equal(as('Bash', { command: 'npm test' }), null);
  assert.ok(denied(as('Write', { file_path: resolve(directory, 'spec.md'), content: '' })), 'artifacts are the orchestrator\'s');
  assert.ok(denied(as('Edit', { file_path: resolve(project, '.project-os/engineering.config.json') })), 'configuration');
  assert.ok(denied(as('Bash', { command: `node "${resolve(toolkit, 'scripts/peos-run.mjs')}" status --project "${project}"` })));
  for (const command of ['git commit -am step', 'git push', 'git reset --hard HEAD~1', 'git stash', 'git -C . commit -m x',
    'git -c user.name=x commit -m x', 'git --no-pager stash', 'npm test && git checkout -- .']) assert.ok(denied(as('Bash', { command })), command);
  for (const command of ['git diff', 'git -C . status', 'git --no-pager log -3', 'git show HEAD:src/todo.js']) assert.equal(as('Bash', { command }), null, command);
});
