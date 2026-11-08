import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, projectDirectory, fail, ToolkitError } from './lib/cli.mjs';
import { validateEvalReport, evalKey, digest, signature } from './lib/eval-report.mjs';
import { runActions, runFlags } from './lib/run-actions.mjs';
import { next, planDigest } from './lib/next.mjs';
import { consumeGrant, insideClaudeCode, writeGrant } from './lib/grants.mjs';
import { codeChanges, treeChanges } from './lib/changes.mjs';
import { loadConfig } from './lib/config.mjs';
import { readManifest, startPreview, stopPreview } from './lib/ui.mjs';
import { snapshotTree, treeExists } from './lib/snapshot.mjs';
import { codeMap } from './lib/map.mjs';
import { emptyProject, setupProject } from './lib/setup.mjs';
import { summarizeUsage, usageFile } from './lib/usage.mjs';
import { requireRoot, headCommit } from './lib/git.mjs';
import {
  runsPath, types, tiers, stages, tierGates, gateArtifacts, gateEvalKeys, gateOrder, designRequested, runDirectory, runSubdirectory, readRunFile,
  readState, writeState, writeAtomic, writeJsonAtomic, withLock, artifactHash, configHash, fingerprint
} from './lib/run-state.mjs';

const verifyScript = fileURLToPath(new URL('verify.mjs', import.meta.url));
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
  await writeFile(resolve(directory, '.gitignore'), 'state.json\nstate.lock\nchecks.json\nbaseline-checks.json\nchanges.diff\ndelta-*.diff\nmap.md\nevals/\npending-eval.json\npending-eval-*.json\nrejected-eval-*.json\n.stop-block\nusage.json\npreview.json\nui/\n*.tmp-*\n');
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
  // Token use is written by the Stop hook; it informs, it never gates.
  let usage = null;
  try { usage = summarizeUsage(JSON.parse(await readRunFile(directory, usageFile) ?? 'null'), state.tier); } catch { usage = null; }
  // Artifact hashes are what spec and plan evaluators must name as their subject.
  return { run: state.run, directory, state, codeState, ...(codeStateError ? { codeStateError } : {}), artifacts, assessment, usage, specSize: await specSize(directory, state) };
}
// The orchestrator's view of a run: only what it acts on, since its context is read again on every turn.
async function brief(project, options) {
  if (options.run === undefined) fail('INVOCATION', '--run is required.');
  const { run, directory, state, artifacts, assessment, usage, specSize: size } = await status(project, options);
  const evals = Object.fromEntries(Object.entries(assessment.evals).map(([key, { verdict, round, fresh }]) => [key, { verdict, round, fresh }]));
  return { run, directory, type: state.type, tier: state.tier, stage: state.stage, gates: assessment.gates, evals, steps: state.steps, artifacts, usage, specSize: size };
}
async function recordChecks(project, options) {
  const directory = await runDirectory(project, options.run);
  await readState(directory);
  choice(options.phase, ['task', 'release'], 'phase');
  const { checks, exitCode } = await runChecks(project, options.phase, options.checks, directory);
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
// Runs created before a file existed have no ignore line for it; screenshots and the
// preview record are working files, never committed.
async function ignoreInRun(directory, entry) {
  const path = resolve(directory, '.gitignore');
  const current = await readFile(path, 'utf8').catch(() => '');
  if (!current.split('\n').includes(entry)) await writeAtomic(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
}
// With a run directory, a ui-capture check that runs writes into a fresh <run>/ui/ and its
// manifest is validated: a capture that passes without usable screenshots fails
// (eval-ui.md §5.2). Checks that run no capture leave the directory alone.
async function runChecks(project, phase, selection, directory = null) {
  const before = await fingerprint(project);
  let uiDir = null;
  if (directory) {
    let selected = null;
    try { selected = selection === undefined ? null : JSON.parse(selection); } catch { selected = []; }
    const config = await loadConfig(project);
    if (config.checks.some(check => check.kind === 'ui-capture' && check.phases.includes(phase) && (!selected || (Array.isArray(selected) && selected.includes(check.id))))) {
      await rm(resolve(directory, 'ui'), { recursive: true, force: true });
      uiDir = await runSubdirectory(directory, 'ui');
      await ignoreInRun(directory, 'ui/');
    }
  }
  const args = [verifyScript, '--project', project, '--phase', phase, ...(selection === undefined ? [] : ['--checks', selection]), ...(uiDir ? ['--ui-dir', uiDir] : []), '--json'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail('VERIFY', 'The verifier returned no structured report.'); }
  if (report.status === 'ERROR') fail(report.error.code, report.error.message);
  let status = result.status ?? 1;
  const captures = report.checks.filter(check => check.kind === 'ui-capture' && check.status !== 'SKIPPED');
  if (uiDir && captures.length) {
    report.ui = captures.some(check => check.status === 'PASS') ? await readManifest(uiDir) : { status: 'failed', reason: 'The ui-capture check did not pass.' };
    if (report.ui.status !== 'captured') {
      for (const check of captures.filter(check => check.status === 'PASS')) Object.assign(check, { status: 'FAIL', reason: `Exited with code 0, but ${report.ui.reason}` });
      // verify's rule: a failed required check makes the run FAIL unless it was interrupted.
      if (!report.interrupted && captures.some(check => check.required && check.status === 'FAIL')) { report.status = 'FAIL'; status = 1; }
    }
  }
  const after = await fingerprint(project);
  // Evidence is bound to a code state only if nothing changed while checks ran.
  const stable = before.codeState === after.codeState;
  const checks = { ...report, codeState: stable ? after.codeState : null, configHash: await configHash(project),
    ...(stable ? {} : { codeStateNote: 'Code changed while checks ran; this result is not bound to a code state.' }) };
  return { checks, exitCode: status };
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
// A report file the evaluator wrote into the run directory is consumed once read, so the
// next round writes a fresh file.
const pendingReport = /^pending-eval-[a-z0-9-]+\.json$/;
// Spec size is counted, not judged: a spec is read again by every agent and round.
const criteriaLimit = (type, tier) => tier !== 'standard' ? null : type === 'feature' ? 15 : 10;
async function specSize(directory, state) {
  const limit = criteriaLimit(state.type, state.tier);
  const source = limit === null ? null : await readRunFile(directory, 'spec.md');
  if (source === null) return null;
  const criteria = (source.match(/^\s*-\s*AC-\d+\s*:/gm) ?? []).length;
  return { criteria, limit, over: criteria > limit };
}
async function recordEval(project, options) {
  const directory = await runDirectory(project, options.run);
  if (typeof options.report !== 'string') fail('INVOCATION', '--report requires a JSON file path or - for stdin.');
  let input, consumed = null;
  try {
    let source;
    if (options.report === '-') source = await readStdin();
    else {
      const path = resolve(options.report);
      if ((await stat(path)).size > reportLimit) fail('EVAL_REPORT', 'Report exceeds 1 MiB.');
      source = await readFile(path, 'utf8');
      if (pendingReport.test(basename(path)) && await realpath(dirname(path)).catch(() => null) === directory) consumed = path;
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
    const size = key === 'spec' ? await specSize(directory, state) : null;
    if (size?.over) fail('SPEC_SIZE', `The spec has ${size.criteria} acceptance criteria; this ${state.type}/${state.tier} run allows ${size.limit}. Merge criteria that pass or fail together.`);
    const previous = state.evals[key];
    const round = previous && previous.verdict !== 'PASS' ? previous.round + 1 : 1;
    if (round > 3) fail('ROUND_LIMIT', `${key} failed three rounds; stop and ask the user.`);
    const evals = await runSubdirectory(directory, 'evals');
    let earlier = null;
    try { earlier = round > 1 ? JSON.parse(await readRunFile(evals, `${key}.json`) ?? 'null') : null; } catch { earlier = null; }
    await writeJsonAtomic(resolve(evals, `${key}.json`), report);
    // The previous round's report stays beside it, so a plateau is visible in a later session.
    if (earlier && report.verdict !== 'PASS') await writeJsonAtomic(resolve(evals, `${key}.prev.json`), earlier);
    else await rm(resolve(evals, `${key}.prev.json`), { force: true });
    await rm(resolve(evals, `${key}.reset.json`), { force: true });
    state.evals[key] = { verdict: report.verdict, round, subject: report.subject };
    // A code evaluation keeps a snapshot of what it judged; the next one can judge only the change since.
    if (!gate) {
      const tree = await snapshotTree(project);
      if (tree && await currentCodeState(project) === report.subject) state.evals[key].tree = tree;
      if (state.evalBases?.[key]) {
        delete state.evalBases[key];
        if (!Object.keys(state.evalBases).length) delete state.evalBases;
        await rm(resolve(evals, `${key}.base.json`), { force: true });
      }
    }
    // Later artifacts evaluated against an older version of this one no longer count.
    if (gate && previous?.subject !== report.subject) {
      for (const later of gateOrder.slice(gateOrder.indexOf(gate) + 1)) delete state.evals[gateEvalKeys[later]];
    }
    await writeState(directory, state);
    // The report is recorded: its pending file has served its purpose.
    if (consumed) await rm(consumed, { force: true });
    // The third consecutive non-PASS round is the last: the orchestrator must stop and ask the user.
    return { run: state.run, key, verdict: report.verdict, round, limitReached: report.verdict !== 'PASS' && round === 3,
      plateau: report.verdict === 'FAIL' && earlier?.verdict === 'FAIL' && signature(earlier) === signature(report), ...digest(report) };
  });
}
// A standard run decides once: the plan approval covers the earlier gates, which until
// then only need a PASS on their current artifact.
const decidedWithPlan = (state, gate) => state.tier === 'standard' ? gateOrder.slice(0, gateOrder.indexOf(gate)).filter(name => Object.hasOwn(state.gates, name)) : [];
function requireFreshPass(assessment, gate) {
  const evaluation = assessment.evals[gateEvalKeys[gate]];
  if (!evaluation || !evaluation.fresh || evaluation.verdict !== 'PASS') fail('GATE', `The ${gateEvalKeys[gate]} evaluation must PASS on the current ${gateArtifacts[gate]} before approval.`);
}
// Gate decisions consume a grant left by the user's own command (design §12).
async function approve(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const gate = choice(options.gate, Object.keys(state.gates), 'gate');
    await consumeGrant(project, 'approve', gate, state.run);
    const assessment = await assess(directory, state, null);
    const covered = gate === 'plan' ? decidedWithPlan(state, gate).filter(name => !assessment.gates[name].fresh) : [];
    const earlier = gateOrder.slice(0, gateOrder.indexOf(gate)).filter(name => Object.hasOwn(state.gates, name));
    const open = earlier.filter(name => !assessment.gates[name].fresh && !covered.includes(name));
    if (open.length) fail('GATE', `Approve earlier gates first: ${open.join(', ')}.`);
    const decided = [...covered, gate];
    for (const name of decided) {
      if (assessment.artifacts[name] === null) fail('GATE', `${gateArtifacts[name]} is missing.`);
      requireFreshPass(assessment, name);
    }
    if (assessment.gates[gate].fresh) return { run: state.run, gate, gates: state.gates };
    // A new approval changes what later artifacts were built on, so later gates must be re-evaluated and re-approved.
    reopenLater(state, gate);
    // A re-approved plan keeps the steps and milestones whose digest did not change; the
    // rest is implemented again, and passed code evaluations become the bases of the next
    // ones (eval-economy.md). The summary of the earlier plan no longer describes the run.
    if (decided.includes('plan')) {
      // The design shapes every interface step as the architecture shapes every step.
      const [architecture, design] = [await readRunFile(directory, 'architecture.md'), await readRunFile(directory, 'design.md')];
      const digest = planDigest(await readRunFile(directory, 'plan.md') ?? '', await readRunFile(directory, 'spec.md'), design === null || !state.gates.design ? architecture : `${architecture ?? ''}\0${design}`);
      if (Object.keys(state.steps).length || state.milestones) {
        const old = state.planDigest;
        const steps = Object.fromEntries(Object.entries(state.steps).filter(([id, status]) => status === 'done' && old?.steps[id] && old.steps[id] === digest.steps[id]));
        const milestones = Object.fromEntries(Object.keys(state.milestones ?? {})
          .filter(id => old?.milestones[id] && old.milestones[id] === digest.milestones[id] && digest.members[id].every(step => steps[step] === 'done')).map(id => [id, 'done']));
        state.steps = steps;
        if (Object.keys(milestones).length) state.milestones = milestones; else delete state.milestones;
        await keepAsBases(directory, state);
        await rm(resolve(directory, 'summary.md'), { force: true });
      }
      state.planDigest = { steps: digest.steps, milestones: digest.milestones };
    }
    const at = new Date().toISOString();
    for (const name of decided) state.gates[name] = { status: 'approved', by: 'human', artifactHash: assessment.artifacts[name], at };
    await writeState(directory, state);
    return { run: state.run, gate, gates: state.gates };
  });
}
// Passed code evaluations with a snapshot become bases: the next evaluation of the key
// judges the change since then with its report; others are dropped.
async function keepAsBases(directory, state) {
  for (const key of Object.keys(state.evals).filter(key => !gateForEval[key])) {
    const evaluation = state.evals[key];
    delete state.evals[key];
    for (const suffix of ['prev', 'reset']) await rm(resolve(directory, 'evals', `${key}.${suffix}.json`), { force: true });
    if (evaluation.verdict !== 'PASS' || !evaluation.tree) continue;
    const report = await readRunFile(resolve(directory, 'evals'), `${key}.json`).catch(() => null);
    if (report === null) continue;
    await writeAtomic(resolve(directory, 'evals', `${key}.base.json`), report);
    state.evalBases = { ...state.evalBases, [key]: { tree: evaluation.tree } };
  }
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
    // The artifact the revision was requested on: until it changes, the producer has work to do.
    const hash = await artifactHash(directory, gate);
    state.gates[gate] = { status: 'revision_requested', ...(hash ? { artifactHash: hash } : {}), at: new Date().toISOString() };
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
    const evals = await runSubdirectory(directory, 'evals');
    // The last report's findings go back to the orchestrator: they are what the next round fixes.
    let last = null;
    try { last = JSON.parse(await readRunFile(evals, `${options.key}.json`) ?? 'null'); } catch { last = null; }
    delete state.evals[options.key];
    // Kept aside so the next round starts from its findings, not from a fresh evaluation
    // of unchanged work (design peos-next.md §5).
    if (last) await writeJsonAtomic(resolve(evals, `${options.key}.reset.json`), last);
    await rm(resolve(evals, `${options.key}.json`), { force: true });
    await rm(resolve(evals, `${options.key}.prev.json`), { force: true });
    await writeState(directory, state);
    return { run: state.run, key: options.key, evals: state.evals, ...(last?.findings ? { last: digest(last) } : {}) };
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
// Project setup: writes the configuration from the project's manifests when it is missing
// and reports instruction files and the project profile's freshness.
async function setup(project) {
  requireRoot(project);
  return setupProject(project);
}
// Reuse aid: the code map, kept in .project-os/cache/code-map.md for every agent and
// rewritten only when the names it lists changed. --run is accepted for older callers.
async function map(project) {
  requireRoot(project);
  return codeMap(project);
}
// Evaluator input: the net code diff against the run's base commit (excluding run files) and security triggers.
async function changes(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  if (!state.baseHead) fail('TRANSITION', 'The run has not entered implementation yet.');
  const before = await fingerprint(project);
  const { files, securityTriggers, uiTriggers, modifiedTests, floorFlags, shortcuts, diff, truncated, bytes } = await codeChanges(project, state.baseHead);
  const { codeState } = await fingerprint(project);
  // The diff must describe exactly the code state evaluators will certify.
  if (codeState !== before.codeState) fail('UNSTABLE', 'The code changed while the diff was computed; run changes again.');
  const diffPath = resolve(directory, 'changes.diff');
  await writeAtomic(diffPath, diff);
  return { run: state.run, base: state.baseHead, codeState, files, securityTriggers, uiTriggers, modifiedTests, floorFlags, shortcuts, diffPath, truncated, diffBytes: bytes };
}
// Delta evaluation input: the change from an evaluation's snapshot to the current code.
// tree: null when Git no longer has the snapshot (the evaluation is then a full one).
async function delta(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  if (!state.baseHead) fail('TRANSITION', 'The run has not entered implementation yet.');
  if (!treeExists(project, options.since)) return { run: state.run, since: options.since, tree: null };
  const before = await fingerprint(project);
  const tree = await snapshotTree(project);
  if (!tree) return { run: state.run, since: options.since, tree: null };
  const change = treeChanges(project, options.since, tree);
  if ((await fingerprint(project)).codeState !== before.codeState) fail('UNSTABLE', 'The code changed while the delta was computed; run delta again.');
  const deltaPath = resolve(directory, `delta-${options.since.slice(0, 12)}.diff`);
  await writeAtomic(deltaPath, change.diff);
  return { run: state.run, since: options.since, tree, codeState: before.codeState, deltaPath, bytes: change.bytes, truncated: change.truncated,
    empty: change.files.length === 0, files: change.files.map(file => file.path), securityTriggers: change.securityTriggers, uiTriggers: change.uiTriggers };
}
// A passed evaluation carried to the current code without an evaluator: over an empty
// change, or for security over a change with no security trigger. The policy is checked
// here, not taken from the caller.
async function carryEval(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const key = options.key;
    if (gateForEval[key] || !/^(?:code-[a-z]+|security|ui)$/.test(key ?? '')) fail('INVOCATION', '--key must be a code, security or ui evaluation.');
    const current = state.evals[key];
    // A base kept at a milestone boundary or plan re-approval judged another scope or plan:
    // only the security evaluation, which judges no criteria, carries from one.
    const base = current ? (current.verdict === 'PASS' ? current.tree : null) : key === 'security' ? state.evalBases?.[key]?.tree : null;
    if (!base || !treeExists(project, base)) fail('CARRY', `${key} has no passed snapshot of the same scope to carry.`);
    const codeState = await currentCodeState(project);
    const tree = await snapshotTree(project);
    if (!codeState || !tree) fail('CARRY', 'The current code state could not be snapshotted.');
    const change = treeChanges(project, base, tree);
    if (change.files.length && !(key === 'security' && !change.securityTriggers.length)) fail('CARRY', `The change since ${key} passed needs an evaluator.`);
    if (await currentCodeState(project) !== codeState) fail('UNSTABLE', 'The code changed while the evaluation was carried.');
    const evals = await runSubdirectory(directory, 'evals');
    const source = await readRunFile(evals, current ? `${key}.json` : `${key}.base.json`);
    if (source === null) fail('CARRY', `The ${key} report is missing.`);
    await writeJsonAtomic(resolve(evals, `${key}.json`), { ...JSON.parse(source), subject: codeState });
    state.evals[key] = { verdict: 'PASS', round: 1, subject: codeState, tree, carried: true };
    if (state.evalBases?.[key]) {
      delete state.evalBases[key];
      if (!Object.keys(state.evalBases).length) delete state.evalBases;
      await rm(resolve(evals, `${key}.base.json`), { force: true });
    }
    await writeState(directory, state);
    return { run: state.run, key, verdict: 'PASS', carried: true, changedFiles: change.files.length };
  });
}
async function advance(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const to = choice(options.to, stages, 'to');
    if (state.stage === 'done') fail('TRANSITION', 'The run is finished.');
    if (to === 'done' && state.stage !== 'release') fail('TRANSITION', 'Only a run at the release stage can finish.');
    // A gated stage starts only on approved earlier artifacts; a standard run plans on an
    // evaluated spec, which the user approves together with the plan.
    if (gateOrder.includes(to)) {
      const assessment = await assess(directory, state, null);
      const covered = decidedWithPlan(state, to).filter(name => !assessment.gates[name].fresh);
      for (const name of covered) requireFreshPass(assessment, name);
      const open = gateOrder.slice(0, gateOrder.indexOf(to)).filter(name => Object.hasOwn(assessment.gates, name) && !assessment.gates[name].fresh && !covered.includes(name));
      if (open.length) fail('GATE', `Approve earlier gates first: ${open.join(', ')}.`);
    }
    if (gatedStages.includes(to)) {
      const codeState = ['release', 'done'].includes(to) ? await currentCodeState(project) : null;
      const assessment = await assess(directory, state, codeState);
      requireGates(assessment);
      // Later stages need the binding made on entering implement, so it cannot be skipped.
      if (to !== 'implement' && !Object.hasOwn(state, 'baseHead')) fail('TRANSITION', 'Enter the implement stage first.');
      // A new application has no checks until its walking skeleton declares them; they are
      // bound when its first checks are recorded (design peos-next.md §6).
      if (to !== 'implement' && state.bootstrap && !Object.hasOwn(state, 'configHash')) {
        if (to !== 'verify') fail('TRANSITION', 'An app run binds its configuration when it first records checks.');
        const hash = await configHash(project);
        if (hash === null) fail('CONFIG_MISSING', 'The walking skeleton has no configuration yet; run setup after it declares a root test command.');
        state.configHash = hash;
      }
      if (to !== 'implement' && !Object.hasOwn(state, 'configHash')) fail('TRANSITION', 'Enter the implement stage first.');
      if (['release', 'done'].includes(to)) requireCodeEvidence(state, assessment, { releasePhase: to === 'done' });
    }
    // On first entry into implement, bind the run to the configured checks and to the
    // commit the change starts from (design §12 residual risks).
    if (to === 'implement' && !Object.hasOwn(state, 'baseHead')) {
      const hash = await configHash(project);
      // Only a new application in an empty repository starts without checks; anywhere else
      // the user first sees the configuration setup derives (orchestrator section 0).
      if (hash === null && !(state.type === 'app' && emptyProject(project))) fail('CONFIG_MISSING', 'Implementation needs .project-os/engineering.config.json with the project\'s checks; run setup and review them.');
      requireRoot(project);
      if (hash === null) state.bootstrap = true;
      else state.configHash = hash;
      state.baseHead = headCommit(project);
      state.baseCodeState = (await fingerprint(project)).codeState;
    }
    state.stage = to;
    await writeState(directory, state);
    // The preview served the evaluation; nothing after it needs the server.
    if (['release', 'done', 'stopped'].includes(to)) await stopPreview(directory);
    return { run: state.run, stage: state.stage };
  });
}
async function step(project, options) {
  const directory = await runDirectory(project, options.run);
  if (typeof options.step !== 'string' || !/^S[1-9][0-9]*(?:,S[1-9][0-9]*)*$/.test(options.step)) fail('INVOCATION', '--step must look like S1 or S1,S2.');
  const value = choice(options.status, ['pending', 'in_progress', 'done', 'reverted'], 'status');
  return withLock(directory, async () => {
    const state = await readState(directory);
    for (const id of options.step.split(',')) state.steps[id] = value;
    await writeState(directory, state);
    return { run: state.run, steps: state.steps };
  });
}

// One call for the bookkeeping around an implementer: entering implementation with its
// map and steps, and from finished steps through recorded checks to the evaluator input.
async function begin(project, options) {
  await advance(project, { ...options, to: 'implement' });
  const { path: mapPath } = await map(project);
  const { steps } = await step(project, { ...options, status: 'in_progress' });
  return { run: options.run, stage: 'implement', steps, mapPath };
}
async function finish(project, options) {
  if (options.step !== undefined) await step(project, { ...options, status: 'done' });
  await advance(project, { ...options, to: 'verify' });
  const { report: { checks }, exitCode } = await recordChecks(project, { ...options, phase: 'task' });
  const failed = checks.checks.filter(check => !['PASS', 'SKIPPED'].includes(check.status)).map(check => check.id);
  const summary = { checks: checks.status, verification: checks.verification, failed };
  // Consecutive failed check runs; the third stops the run (design peos-next.md §5).
  const directory = await runDirectory(project, options.run);
  await withLock(directory, async () => {
    const state = await readState(directory);
    state.verifyFailures = checks.status === 'PASS' ? 0 : (state.verifyFailures ?? 0) + 1;
    await writeState(directory, state);
  });
  if (checks.status !== 'PASS') return { report: { run: options.run, stage: 'verify', ...summary }, exitCode };
  await advance(project, { ...options, to: 'evaluate' });
  return { report: { stage: 'evaluate', ...summary, ...await changes(project, options) }, exitCode };
}

// The run's local preview for eval-ui (eval-ui.md §5.1); peos-run, not an agent, starts
// and stops the server, so it runs only the configured command on a loopback origin.
async function previewStart(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  if (!['implement', 'verify', 'evaluate'].includes(state.stage)) fail('TRANSITION', 'A preview serves evaluation; the run is not implementing or evaluating.');
  const config = await loadConfig(project);
  if (!config.preview) fail('PREVIEW', 'No preview is configured in .project-os/engineering.config.json.');
  await ignoreInRun(directory, 'preview.json');
  const preview = await startPreview(project, directory, config.preview);
  return { run: state.run, ...preview, viewports: config.preview.viewports, colorSchemes: config.preview.colorSchemes };
}
async function previewStop(project, options) {
  const directory = await runDirectory(project, options.run);
  const state = await readState(directory);
  return { run: state.run, ...await stopPreview(directory) };
}

// A large run's milestone is done once its steps passed checks and evaluation.
async function completeMilestone(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    state.milestones = { ...state.milestones, [options.milestone]: 'done' };
    // Its code evaluations judged only the criteria in its scope; the next milestone starts
    // a new series, so a scoped PASS is never reused as the final evaluation.
    // The last milestone's evaluations judged every criterion and are the release evidence.
    // They stay as bases, so the next milestone's evaluations judge only what it changes.
    if (!options.final) await keepAsBases(directory, state);
    await writeState(directory, state);
    return { run: state.run, milestones: state.milestones };
  });
}
// The design gate follows the spec (design-gate.md): a standard or large run has it while
// spec.md says `Design: new`; one not approved on the current spec goes when it no longer asks for it.
async function designGate(project, options) {
  const directory = await runDirectory(project, options.run);
  return withLock(directory, async () => {
    const state = await readState(directory);
    const wanted = ['standard', 'large'].includes(state.tier) && designRequested(await readRunFile(directory, 'spec.md'));
    const present = Object.hasOwn(state.gates, 'design');
    if (wanted && !present) {
      state.gates = Object.fromEntries(gateOrder.filter(name => name === 'design' || Object.hasOwn(state.gates, name)).map(name => [name, state.gates[name] ?? { status: 'pending' }]));
    } else if (!wanted && present && !(await assess(directory, state, null)).gates.design.fresh) {
      delete state.gates.design;
      delete state.evals[gateEvalKeys.design];
    } else return { run: state.run, changed: false, design: present };
    await writeState(directory, state);
    return { run: state.run, changed: true, design: wanted };
  });
}
// The run's control flow: the next action for the orchestrator (design peos-next.md).
function nextAction(project, options) {
  return next(project, options, { status, advance, step, recordEval, changes, delta, carryEval, map, setup, completeMilestone, designGate });
}

const handlers = { init, status, brief, begin, finish, next: nextAction, 'record-checks': recordChecks, 'record-eval': recordEval, approve, revise, 'reset-eval': resetEval, advance, step, grant, changes, delta, 'carry-eval': carryEval, 'record-baseline': recordBaseline, map, setup,
  'preview-start': previewStart, 'preview-stop': previewStop,
  fingerprint: project => fingerprint(project) };

await main(async () => {
  const [action, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(actions, action)) fail('INVOCATION', `First argument must be an action: ${Object.keys(actions).join(', ')}.`);
  const options = parseArgs(rest, actions[action], ['json', ...(runFlags[action] ?? [])]);
  const project = await projectDirectory(options.project);
  const outcome = await handlers[action](project, options);
  const { report, exitCode = 0 } = ['record-checks', 'record-baseline', 'finish'].includes(action) ? outcome : { report: outcome };
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
    report.assessment.checks ? `checks: ${report.assessment.checks.status} ${report.assessment.checks.verification} ${report.assessment.checks.phase}${report.assessment.checks.fresh ? '' : ' (stale)'}` : 'checks: none recorded',
    ...(report.usage ? [`usage: ${(report.usage.total / 1e6).toFixed(1)}M tokens in ${report.usage.calls} model calls (budget ${(report.usage.budget / 1e6).toFixed(1)}M for ${report.state.tier})${report.usage.overBudget ? ' — over budget' : ''}`] : [])
  ].join('\n');
  if (report.action === 'fingerprint') return `${report.codeState} (HEAD ${report.head}, ${report.changedPaths} changed paths)`;
  if (report.action === 'map') return report.path ? `Code map ${report.changed ? 'written to' : 'unchanged at'} ${JSON.stringify(report.path)} (${report.folders} folders, ${report.read} file(s) read).` : report.map || 'No top-level definitions found.';
  if (report.action === 'record-baseline') return `${report.baseline.status}: refactor baseline recorded for ${report.run} at ${report.baseline.base.slice(0, 12)}`;
  if (report.action === 'record-checks') return `${report.checks.status}: checks recorded for ${report.run}${report.checks.codeState ? '' : ` — ${report.checks.codeStateNote}`}`;
  if (report.action === 'record-eval') return `${report.verdict}: ${report.key} round ${report.round} recorded for ${report.run}`;
  if (report.action === 'setup') return [
    report.config === 'deferred' ? 'config: deferred (empty project: an app run configures checks after its walking skeleton)' : `config: ${report.config} (${report.checks.join('; ')})`,
    ...(report.addedChecks.length ? [`checks added: ${report.addedChecks.join('; ')}`] : []),
    ...(report.suggestedChecks.length ? [`checks to add after the active run: ${report.suggestedChecks.join('; ')}`] : []),
    ...Object.entries(report.instructions).map(([file, state]) => `${file}: ${state}`),
    `profile: ${report.profile.status}${report.profile.reason ? ` (${report.profile.reason})` : ''}`
  ].join('\n');
  if (report.action === 'finish') return `${report.run}: ${report.checks} checks, stage ${report.stage}${report.failed.length ? `, failed: ${report.failed.join(', ')}` : ''}`;
  if (report.action === 'preview-start') return `Preview for ${report.run} ${report.reused ? 'already running' : 'started'} at ${report.url}.`;
  if (report.action === 'preview-stop') return `Preview for ${report.run} ${report.stopped ? 'stopped' : 'was not running'}.`;
  if (report.action === 'init') return `Run ${report.run} created at ${JSON.stringify(report.directory)}.`;
  if (report.action === 'next') return `${report.run} at ${report.stage}: ${report.do}${report.message ? ` — ${report.message}` : ''}`;
  return `${report.action}: ${report.run} updated.`;
});
