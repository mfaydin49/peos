import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, projectDirectory, fail, ToolkitError } from './lib/cli.mjs';
import { validateEvalReport, evalKey } from './lib/eval-report.mjs';
import { runActions } from './lib/run-actions.mjs';
import { consumeGrant, insideClaudeCode, writeGrant } from './lib/grants.mjs';
import { codeChanges } from './lib/changes.mjs';
import { requireRoot, headCommit } from './lib/git.mjs';
import {
  runsPath, types, tiers, stages, tierGates, gateArtifacts, gateEvalKeys, runDirectory, runSubdirectory, readRunFile,
  readState, writeState, writeAtomic, writeJsonAtomic, withLock, artifactHash, configHash, fingerprint
} from './lib/run-state.mjs';

const verifyScript = fileURLToPath(new URL('verify.mjs', import.meta.url));
const gateOrder = ['spec', 'architecture', 'plan'];
const gateForEval = Object.fromEntries(Object.entries(gateEvalKeys).map(([gate, key]) => [key, gate]));
const gatedStages = ['implement', 'verify', 'evaluate', 'release', 'done'];
// Large runs split the code evaluation by focus; smaller tiers need at least one code evaluation (design §6).
const requiredCodeEvals = { large: ['code-acceptance', 'code-quality', 'code-tests'] };
const actions = runActions;

function localDate() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}
function choice(value, allowed, option) {
  if (!allowed.includes(value)) fail('INVOCATION', `--${option} must be one of: ${allowed.join(', ')}.`);
  return value;
}
async function currentCodeState(project) {
  try { return (await fingerprint(project)).codeState; }
  catch (error) { if (error instanceof ToolkitError && ['NOT_GIT', 'NO_HEAD'].includes(error.code)) return null; throw error; }
}
async function readChecks(directory, name = 'checks.json') {
  const source = await readRunFile(directory, name);
  if (source === null) return null;
  try { return JSON.parse(source); } catch { fail('STATE', `${name} must be valid JSON.`); }
}

// Freshness: a gate holds only while its artifact is unchanged and every earlier gate holds.
async function assess(directory, state, codeState) {
  const gates = {}, artifacts = {};
  let upstreamFresh = true;
  for (const name of gateOrder.filter(name => Object.hasOwn(state.gates, name))) {
    const gate = state.gates[name];
    artifacts[name] = await artifactHash(directory, name);
    const fresh = upstreamFresh && gate.status === 'approved' && gate.artifactHash === artifacts[name];
    gates[name] = { status: gate.status, fresh };
    upstreamFresh = fresh;
  }
  const evals = {};
  for (const [key, summary] of Object.entries(state.evals)) {
    const gate = gateForEval[key];
    const expected = gate ? artifacts[gate] ?? await artifactHash(directory, gate) : codeState;
    evals[key] = { ...summary, fresh: expected !== null && summary.subject === expected };
  }
  const report = await readChecks(directory);
  const checks = report && { status: report.status, phase: report.phase, verification: report.verification,
    fresh: codeState !== null && report.codeState === codeState,
    configMatches: Object.hasOwn(state, 'configHash') && report.configHash === state.configHash };
  const baselineReport = await readChecks(directory, 'baseline-checks.json');
  const baseline = baselineReport && { status: baselineReport.status, verification: baselineReport.verification,
    matches: baselineReport.base === state.baseHead && baselineReport.configHash === state.configHash
      && baselineReport.codeState !== null && baselineReport.codeState === state.baseCodeState };
  return { gates, evals, checks, baseline, artifacts };
}
function requireGates(assessment) {
  const open = Object.entries(assessment.gates).filter(([, gate]) => !gate.fresh).map(([name]) => name);
  if (open.length) fail('GATE', `Human gates are not approved for the current artifacts: ${open.join(', ')}.`);
}
// Release accepts full PASS checks of either phase; finishing needs release-phase checks.
function requireCodeEvidence(state, assessment, { releasePhase }) {
  const { checks, evals } = assessment;
  if (!checks || !checks.fresh || checks.status !== 'PASS' || checks.verification !== 'full' || (releasePhase && checks.phase !== 'release')) {
    fail('EVIDENCE', `A full PASS ${releasePhase ? 'release-phase ' : ''}verification must be recorded for the current code state.`);
  }
  if (!checks.configMatches) fail('EVIDENCE', 'The checks were not recorded with the configuration this run started implementation with; the user must review the configuration change (revert it or start a new run).');
  // A refactor must show the same checks passed before any change (design §7).
  const { baseline } = assessment;
  if (state.type === 'refactor' && !(baseline && baseline.status === 'PASS' && baseline.verification === 'full' && baseline.matches)) {
    fail('EVIDENCE', 'A refactor needs a full PASS baseline recorded with record-baseline on the code as it was when implementation started, with this run\'s configuration.');
  }
  const codeEvals = Object.entries(evals).filter(([key]) => !gateForEval[key]);
  const required = requiredCodeEvals[state.tier] ?? [];
  const missing = required.filter(key => !Object.hasOwn(evals, key));
  if (missing.length) fail('EVIDENCE', `Required code evaluations are missing: ${missing.join(', ')}.`);
  if (!codeEvals.some(([key]) => key.startsWith('code-'))) fail('EVIDENCE', 'At least one code evaluation is required.');
  const open = codeEvals.filter(([, summary]) => !summary.fresh || summary.verdict !== 'PASS').map(([key]) => key);
  if (open.length) fail('EVIDENCE', `Evaluations are not PASS for the current code state: ${open.join(', ')}.`);
}

async function init(project, options) {
  if (typeof options.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.name)) fail('INVOCATION', '--name must use lowercase letters, digits and single hyphens.');
  const type = choice(options.type, types, 'type');
  const tier = choice(options.tier, tiers, 'tier');
  if (type === 'app' && tier !== 'large') fail('INVOCATION', 'A new application is always the large tier.');
  const run = `${localDate()}-${options.name}`;
  const directory = await runDirectory(project, run, { create: true });
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') fail('RUN_EXISTS', 'A run with this name already exists today.'); throw error; }
  // Evidence and state are working files; committed artifacts are the Markdown documents.
  await writeFile(resolve(directory, '.gitignore'), 'state.json\nstate.lock\nchecks.json\nbaseline-checks.json\nchanges.diff\nevals/\npending-eval.json\n.stop-block\n*.tmp-*\n');
  const now = new Date().toISOString();
  const state = { schemaVersion: 1, run, type, tier, stage: 'intake',
    gates: Object.fromEntries(tierGates[tier].map(gate => [gate, { status: 'pending' }])),
    steps: {}, evals: {}, checkpoints: [], createdAt: now, updatedAt: now };
  await withLock(directory, () => writeState(directory, state));
  return { run, directory, state };
}
async function status(project, options) {
  if (options.run === undefined) {
    let names = [];
    try { names = (await readdir(resolve(project, runsPath))).filter(name => !name.startsWith('.')).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const runs = [];
    for (const name of names) {
      try {
        const state = await readState(await runDirectory(project, name));
        runs.push({ run: name, type: state.type, tier: state.tier, stage: state.stage, updatedAt: state.updatedAt });
      } catch (error) { if (!(error instanceof ToolkitError)) throw error; runs.push({ run: name, error: error.code }); }
    }
    return { runs };
  }
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  // Status stays readable when code evidence cannot be bound; code evidence then shows as stale.
  let codeState = null, codeStateError;
  try { codeState = await currentCodeState(project); }
  catch (error) { if (!(error instanceof ToolkitError) || error.code !== 'FINGERPRINT') throw error; codeStateError = error.message; }
  const { artifacts, ...assessment } = await assess(directory, state, codeState);
  // Artifact hashes are what spec and plan evaluators must name as their subject.
  return { run: state.run, directory, state, codeState, ...(codeStateError ? { codeStateError } : {}), artifacts, assessment };
}
async function recordChecks(project, options) {
  const directory = await runDirectory(project, options.run);
  await readState(directory);
  choice(options.phase, ['task', 'release'], 'phase');
  const { checks, exitCode } = await runChecks(project, options.phase, options.checks);
  await writeJsonAtomic(resolve(directory, 'checks.json'), checks);
  return { report: { run: options.run, checks }, exitCode };
}
// Refactor baseline: the full task-phase checks on the untouched base commit, recorded once
// after entering implement and before the first code change.
async function recordBaseline(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  if (!state.baseHead) fail('TRANSITION', 'Enter the implement stage first.');
  // Exactly the code state the run started implementation from; earlier local edits are part of it.
  if (!state.baseCodeState || (await fingerprint(project)).codeState !== state.baseCodeState) {
    fail('BASELINE', 'The baseline must be recorded on the code as it was when implementation started. Restore that state (for example, have the user stash the run\'s changes) and record it again, or start a new run.');
  }
  const { checks, exitCode } = await runChecks(project, 'task');
  const baseline = { ...checks, base: state.baseHead };
  await writeJsonAtomic(resolve(directory, 'baseline-checks.json'), baseline);
  return { report: { run: state.run, baseline }, exitCode };
}
async function runChecks(project, phase, selection) {
  const before = await fingerprint(project);
  const args = [verifyScript, '--project', project, '--phase', phase, ...(selection === undefined ? [] : ['--checks', selection]), '--json'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail('VERIFY', 'The verifier returned no structured report.'); }
  if (report.status === 'ERROR') fail(report.error.code, report.error.message);
  const after = await fingerprint(project);
  // Evidence is bound to a code state only if nothing changed while checks ran.
  const stable = before.codeState === after.codeState;
  const checks = { ...report, codeState: stable ? after.codeState : null, configHash: await configHash(project),
    ...(stable ? {} : { codeStateNote: 'Code changed while checks ran; this result is not bound to a code state.' }) };
  return { checks, exitCode: result.status ?? 1 };
}
const reportLimit = 1024 * 1024;
async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > reportLimit) fail('EVAL_REPORT', 'Report exceeds 1 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// "--report -" reads stdin, so the orchestrator can pass an evaluator's output without a temporary file.
async function recordEval(project, options) {
  const directory = await runDirectory(project, options.run);
  if (typeof options.report !== 'string') fail('INVOCATION', '--report requires a JSON file path or - for stdin.');
  let input;
  try {
    let source;
    if (options.report === '-') source = await readStdin();
    else {
      const path = resolve(options.report);
      if ((await stat(path)).size > reportLimit) fail('EVAL_REPORT', 'Report exceeds 1 MiB.');
      source = await readFile(path, 'utf8');
    }
    input = JSON.parse(source);
  } catch (error) { if (error instanceof ToolkitError) throw error; fail('EVAL_REPORT', 'Report must be readable JSON.'); }
  const report = validateEvalReport(input);
  const key = evalKey(report);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const gate = gateForEval[key];
    if (gate && !Object.hasOwn(state.gates, gate)) fail('EVAL_REPORT', `This ${state.tier} run has no ${gate} gate.`);
    const expected = gate ? await artifactHash(directory, gate) : await currentCodeState(project);
    if (expected === null) fail('EVAL_REPORT', gate ? `${gateArtifacts[gate]} is missing.` : 'Code evaluations need a Git working-tree root with a commit.');
    if (report.subject !== expected) fail('STALE', 'The report judged a different artifact or code state than the current one; re-run the evaluator.');
    const previous = state.evals[key];
    const round = previous && previous.verdict !== 'PASS' ? previous.round + 1 : 1;
    if (round > 3) fail('ROUND_LIMIT', `${key} failed three rounds; stop and ask the user.`);
    await writeJsonAtomic(resolve(await runSubdirectory(directory, 'evals'), `${key}.json`), report);
    state.evals[key] = { verdict: report.verdict, round, subject: report.subject };
    await writeState(directory, state);
    // The third consecutive non-PASS round is the last: the orchestrator must stop and ask the user.
    return { run: state.run, key, verdict: report.verdict, round, limitReached: report.verdict !== 'PASS' && round === 3 };
  });
}
// Gate decisions consume a grant left by the user's own command (design §12).
async function approve(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const gate = choice(options.gate, Object.keys(state.gates), 'gate');
    await consumeGrant(project, 'approve', gate, state.run);
    const assessment = await assess(directory, state, null);
    const earlier = gateOrder.slice(0, gateOrder.indexOf(gate)).filter(name => Object.hasOwn(state.gates, name));
    const open = earlier.filter(name => !assessment.gates[name].fresh);
    if (open.length) fail('GATE', `Approve earlier gates first: ${open.join(', ')}.`);
    const hash = assessment.artifacts[gate];
    if (hash === null) fail('GATE', `${gateArtifacts[gate]} is missing.`);
    const evaluation = assessment.evals[gateEvalKeys[gate]];
    if (!evaluation || !evaluation.fresh || evaluation.verdict !== 'PASS') fail('GATE', `The ${gateEvalKeys[gate]} evaluation must PASS on the current ${gateArtifacts[gate]} before approval.`);
    if (assessment.gates[gate].fresh) return { run: state.run, gate, gates: state.gates };
    // A new approval changes what later artifacts were built on, so later gates must be re-evaluated and re-approved.
    reopenLater(state, gate);
    state.gates[gate] = { status: 'approved', by: 'human', artifactHash: hash, at: new Date().toISOString() };
    await writeState(directory, state);
    return { run: state.run, gate, gates: state.gates };
  });
}
function reopenLater(state, gate) {
  for (const name of gateOrder.slice(gateOrder.indexOf(gate) + 1).filter(name => Object.hasOwn(state.gates, name))) {
    state.gates[name] = { status: 'pending' };
    delete state.evals[gateEvalKeys[name]];
  }
}
// A revision reopens the gate and every later gate, and discards their evaluations.
async function revise(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    if (state.stage === 'done') fail('TRANSITION', 'The run is finished; start a new run instead.');
    const gate = choice(options.gate, Object.keys(state.gates), 'gate');
    await consumeGrant(project, 'revise', gate, state.run);
    reopenLater(state, gate);
    state.gates[gate] = { status: 'revision_requested' };
    delete state.evals[gateEvalKeys[gate]];
    state.stage = gate;
    await writeState(directory, state);
    return { run: state.run, gate, stage: state.stage, gates: state.gates };
  });
}
// Reserved like approve: after the round limit, only the human decides to continue (design §9).
async function resetEval(project, options) {
  const directory = await runDirectory(project, options.run);
  if (typeof options.key !== 'string' || !/^[a-z]+(?:-[a-z0-9]+)*$/.test(options.key)) fail('INVOCATION', '--key must be an evaluation key such as code-all.');
  return withLock(directory, async () => {
    const state = await readState(directory);
    if (!Object.hasOwn(state.evals, options.key)) fail('INVOCATION', 'No evaluation with this key is recorded.');
    await consumeGrant(project, 'reset-eval', options.key, state.run);
    delete state.evals[options.key];
    await rm(resolve(await runSubdirectory(directory, 'evals'), `${options.key}.json`), { force: true });
    await writeState(directory, state);
    return { run: state.run, key: options.key, evals: state.evals };
  });
}
// Records a user decision on hosts without the approval-capture hook (Codex, a terminal).
// Inside Claude Code the state-guard hook denies this action to the model.
async function grant(project, options) {
  if (insideClaudeCode()) fail('GRANT', 'Inside Claude Code the user records decisions by typing /peos:approve, /peos:revise or /peos:retry.');
  const action = choice(options.action, ['approve', 'revise', 'reset-eval'], 'action');
  if (options.run !== undefined) await runDirectory(project, options.run);
  return { grant: await writeGrant(project, { action, target: options.target, run: options.run ?? null, source: 'cli' }) };
}
// Evaluator input: the net code diff against the run's base commit (excluding run files) and security triggers.
async function changes(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  if (!state.baseHead) fail('TRANSITION', 'The run has not entered implementation yet.');
  const before = await fingerprint(project);
  const { files, securityTriggers, modifiedTests, diff, truncated } = await codeChanges(project, state.baseHead);
  const { codeState } = await fingerprint(project);
  // The diff must describe exactly the code state evaluators will certify.
  if (codeState !== before.codeState) fail('UNSTABLE', 'The code changed while the diff was computed; run changes again.');
  const diffPath = resolve(directory, 'changes.diff');
  await writeAtomic(diffPath, diff);
  return { run: state.run, base: state.baseHead, codeState, files, securityTriggers, modifiedTests, diffPath, truncated };
}
async function advance(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const to = choice(options.to, stages, 'to');
    if (state.stage === 'done') fail('TRANSITION', 'The run is finished.');
    if (to === 'done' && state.stage !== 'release') fail('TRANSITION', 'Only a run at the release stage can finish.');
    // A gated stage starts only on approved earlier artifacts, e.g. planning needs a fresh spec approval.
    if (gateOrder.includes(to)) {
      const assessment = await assess(directory, state, null);
      const open = gateOrder.slice(0, gateOrder.indexOf(to)).filter(name => Object.hasOwn(assessment.gates, name) && !assessment.gates[name].fresh);
      if (open.length) fail('GATE', `Approve earlier gates first: ${open.join(', ')}.`);
    }
    if (gatedStages.includes(to)) {
      const codeState = ['release', 'done'].includes(to) ? await currentCodeState(project) : null;
      const assessment = await assess(directory, state, codeState);
      requireGates(assessment);
      // Later stages need the binding made on entering implement, so it cannot be skipped.
      if (to !== 'implement' && !Object.hasOwn(state, 'configHash')) fail('TRANSITION', 'Enter the implement stage first.');
      if (['release', 'done'].includes(to)) requireCodeEvidence(state, assessment, { releasePhase: to === 'done' });
    }
    // On first entry into implement, bind the run to the configured checks and to the
    // commit the change starts from (design §12 residual risks).
    if (to === 'implement' && !Object.hasOwn(state, 'configHash')) {
      const hash = await configHash(project);
      if (hash === null) fail('CONFIG_MISSING', 'Implementation needs .project-os/engineering.config.json with the project\'s checks; ask the user to create it.');
      requireRoot(project);
      state.configHash = hash;
      state.baseHead = headCommit(project);
      state.baseCodeState = (await fingerprint(project)).codeState;
    }
    state.stage = to;
    await writeState(directory, state);
    return { run: state.run, stage: state.stage };
  });
}
async function step(project, options) {
  const directory = await runDirectory(project, options.run);
  if (typeof options.step !== 'string' || !/^S[1-9][0-9]*$/.test(options.step)) fail('INVOCATION', '--step must look like S1.');
  const value = choice(options.status, ['pending', 'in_progress', 'done', 'reverted'], 'status');
  return withLock(directory, async () => {
    const state = await readState(directory);
    state.steps[options.step] = value;
    await writeState(directory, state);
    return { run: state.run, steps: state.steps };
  });
}

const handlers = { init, status, 'record-checks': recordChecks, 'record-eval': recordEval, approve, revise, 'reset-eval': resetEval, advance, step, grant, changes, 'record-baseline': recordBaseline,
  fingerprint: project => fingerprint(project) };

await main(async () => {
  const [action, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(actions, action)) fail('INVOCATION', `First argument must be an action: ${Object.keys(actions).join(', ')}.`);
  const options = parseArgs(rest, actions[action]);
  const project = await projectDirectory(options.project);
  const outcome = await handlers[action](project, options);
  const { report, exitCode = 0 } = ['record-checks', 'record-baseline'].includes(action) ? outcome : { report: outcome };
  return { report: { reportVersion: 1, kind: 'run-state', action, status: 'PASS', ...report }, exitCode };
}, report => {
  if (report.action === 'status' && report.runs) return report.runs.length
    ? report.runs.map(run => run.error ? `${run.run}: unreadable (${run.error})` : `${run.run}: ${run.type}/${run.tier} at ${run.stage}`).join('\n')
    : 'No runs.';
  if (report.action === 'status') return [
    `${report.run}: ${report.state.type}/${report.state.tier} at ${report.state.stage}`,
    ...Object.entries(report.assessment.gates).map(([name, gate]) => `gate ${name}: ${gate.status}${gate.status === 'approved' && !gate.fresh ? ' (stale)' : ''}`),
    ...Object.entries(report.assessment.evals).map(([key, evaluation]) => `eval ${key}: ${evaluation.verdict} round ${evaluation.round}${evaluation.fresh ? '' : ' (stale)'}`),
    ...(report.assessment.baseline ? [`baseline: ${report.assessment.baseline.status} ${report.assessment.baseline.verification}${report.assessment.baseline.matches ? '' : ' (does not match this run)'}`]
      : report.state.type === 'refactor' ? ['baseline: none recorded (required for a refactor)'] : []),
    report.assessment.checks ? `checks: ${report.assessment.checks.status} ${report.assessment.checks.verification} ${report.assessment.checks.phase}${report.assessment.checks.fresh ? '' : ' (stale)'}` : 'checks: none recorded'
  ].join('\n');
  if (report.action === 'fingerprint') return `${report.codeState} (HEAD ${report.head}, ${report.changedPaths} changed paths)`;
  if (report.action === 'record-baseline') return `${report.baseline.status}: refactor baseline recorded for ${report.run} at ${report.baseline.base.slice(0, 12)}`;
  if (report.action === 'record-checks') return `${report.checks.status}: checks recorded for ${report.run}${report.checks.codeState ? '' : ` — ${report.checks.codeStateNote}`}`;
  if (report.action === 'record-eval') return `${report.verdict}: ${report.key} round ${report.round} recorded for ${report.run}`;
  if (report.action === 'init') return `Run ${report.run} created at ${JSON.stringify(report.directory)}.`;
  return `${report.action}: ${report.run} updated.`;
});
