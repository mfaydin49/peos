// The run's control flow (design peos-next.md): from the state, the run files and the code
// state, apply every bookkeeping step that needs no outside work and return exactly one
// action for the orchestrator. The orchestrator only loops: next → do it → next.
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ToolkitError } from './cli.mjs';
import { loadConfig } from './config.mjs';
import { digest, signature } from './eval-report.mjs';
import { headCommit } from './git.mjs';
import { gateArtifacts, gateEvalKeys, readRunFile } from './run-state.mjs';

const toolkit = fileURLToPath(new URL('../../', import.meta.url));
const template = name => resolve(toolkit, 'templates/run', name);
const gateOrder = ['spec', 'architecture', 'plan'];
const producers = { spec: 'peos:spec-writer', architecture: 'peos:architect', plan: 'peos:planner' };
const gateEvaluators = { spec: 'peos:eval-spec', architecture: 'peos:eval-plan', plan: 'peos:eval-plan' };
const codeStages = ['implement', 'verify', 'evaluate'];
const pendingReport = /^pending-eval-([a-z0-9-]+)\.json$/;
// Bookkeeping steps per call; more means the state does not converge, which is a defect.
const transitionLimit = 25;

async function exists(path) {
  return Boolean((await lstat(path).catch(() => null))?.isFile());
}
async function readJson(directory, name) {
  try { return JSON.parse(await readRunFile(directory, name) ?? 'null'); } catch { return null; }
}
async function configOrNull(project) {
  try { return await loadConfig(project); }
  catch (error) { if (error instanceof ToolkitError && error.code === 'CONFIG_MISSING') return null; throw error; }
}
const checkLines = (config, phase = 'task') => config
  ? config.checks.filter(entry => entry.phases.includes(phase)).map(entry => `${entry.id}: ${[entry.executable, ...entry.args].join(' ')}`)
  : ['none yet: the walking skeleton must declare a root test command in its manifest (for example a package.json "test" script) with one passing test'];

// Steps and milestones from the run's plan: `### S<n>` headings (with `- Covers:` lines) in
// plan.md, `- S<n>:` lines in task.md, and `- M<n>: … steps: S1, S2` milestone lines.
export function parsePlan(source, { task = false } = {}) {
  const steps = [], covers = {};
  if (task) {
    for (const [, id, rest] of source.matchAll(/^\s*-\s*(S[1-9]\d*)\s*:(.*)$/gm)) {
      steps.push(id);
      covers[id] = [...(/covers:\s*([^—\n]*)/i.exec(rest)?.[1] ?? '').matchAll(/AC-\d+/g)].map(match => match[0]);
    }
    return { steps, covers, milestones: [] };
  }
  const sections = source.split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const id = /^(S[1-9]\d*)\b/.exec(section)?.[1];
    if (!id) continue;
    steps.push(id);
    covers[id] = [...(/^\s*-\s*Covers:(.*)$/mi.exec(section)?.[1] ?? '').matchAll(/AC-\d+/g)].map(match => match[0]);
  }
  const milestones = [];
  for (const [, id, list] of source.matchAll(/^\s*-\s*(M[1-9]\d*)\s*:.*?steps?:\s*([S\d,\s]+)$/gmi)) {
    milestones.push({ id, steps: [...list.matchAll(/S[1-9]\d*/g)].map(match => match[0]).filter(step => steps.includes(step)) });
  }
  return { steps, covers, milestones };
}
// Large runs work milestone by milestone; steps no milestone names join the last one.
function milestonesOf(plan, state) {
  if (state.tier !== 'large' || !plan.milestones.length) return [{ id: 'M1', steps: plan.steps, implicit: true }];
  const named = new Set(plan.milestones.flatMap(milestone => milestone.steps));
  const rest = plan.steps.filter(step => !named.has(step));
  return plan.milestones.map((milestone, index, all) => index === all.length - 1 ? { ...milestone, steps: [...milestone.steps, ...rest] } : milestone);
}

export async function next(project, options, h) {
  if (options.run === undefined) fail('INVOCATION', '--run is required.');
  const run = options.run;
  const applied = [];
  const errors = {};
  let { directory } = await h.status(project, { run });
  if (options.done !== undefined) {
    await h.step(project, { run, step: options.done, status: 'done' });
    applied.push(`steps ${options.done} done`);
  }
  // Reports evaluators left behind are recorded first; a rejected one is kept aside once,
  // and the evaluator runs again with the error.
  for (const name of (await readdir(directory)).filter(entry => pendingReport.test(entry)).sort()) {
    const key = pendingReport.exec(name)[1];
    const rejected = `rejected-eval-${key}.json`;
    try {
      await h.recordEval(project, { run, report: resolve(directory, name) });
      await rm(resolve(directory, rejected), { force: true });
      applied.push(`recorded ${key}`);
    } catch (error) {
      if (!(error instanceof ToolkitError)) throw error;
      if (await exists(resolve(directory, rejected))) {
        await rm(resolve(directory, name), { force: true });
        const { state } = await h.status(project, { run });
        return { run: state.run, directory, stage: state.stage, applied, do: 'stop', code: 'EVAL_REPORT',
          message: `The ${key} report was rejected twice (${error.code}: ${error.message}). Ask the user how to continue.` };
      }
      await rename(resolve(directory, name), resolve(directory, rejected));
      errors[key] = `${error.code}: ${error.message}`;
    }
  }
  for (let count = 0; count < transitionLimit; count++) {
    const context = await h.status(project, { run });
    ({ directory } = context);
    const outcome = await decide(project, context, { options, errors, h });
    if (outcome.applied) { applied.push(outcome.applied); continue; }
    return { run: context.state.run, directory, stage: context.state.stage, applied, ...outcome };
  }
  fail('INTERNAL', 'The run state did not settle; report this as a PEOS defect.');
}

// One decision on the current state: either a bookkeeping step it took ({ applied }) or
// the action for the orchestrator.
async function decide(project, context, { options, errors, h }) {
  const { state, directory, artifacts, assessment, codeState, specSize } = context;
  const run = state.run;
  const path = name => resolve(directory, name);
  const config = await configOrNull(project);
  const profilePath = resolve(project, '.project-os/project-profile.md');
  const profile = await exists(profilePath) ? profilePath : undefined;
  const common = { 'output language': config?.outputLanguage ?? 'tr', profile, 'project instructions': config?.references.instructions ?? ['AGENTS.md'] };
  const investigation = await exists(path('investigation.md')) ? path('investigation.md') : undefined;
  const idea = await exists(path('idea.md')) ? path('idea.md') : undefined;
  const architecture = state.gates.architecture ? path('architecture.md') : undefined;
  // A refused transition is the user's to resolve; its reason is the message.
  const advance = async to => {
    try { await h.advance(project, { run, to }); }
    catch (error) { if (error instanceof ToolkitError) return { do: 'stop', code: error.code, message: error.message }; throw error; }
    return { applied: `stage ${to}` };
  };

  if (state.stage === 'done') return { do: 'finished', summary: path('summary.md') };
  if (state.stage === 'stopped') return { do: 'stop', code: 'STOPPED', message: 'The run was stopped; start a new run.' };

  // Gates, in order. A standard run passes its spec on a PASS and decides spec and plan
  // together at the plan gate.
  for (const gate of gateOrder.filter(name => Object.hasOwn(state.gates, name))) {
    if (assessment.gates[gate].fresh) continue;
    const key = gateEvalKeys[gate];
    const evaluation = assessment.evals[key];
    const hash = artifacts[gate];
    const revising = state.gates[gate].status === 'revision_requested' && (hash === null || state.gates[gate].artifactHash === hash);
    if (state.tier === 'standard' && gate === 'spec' && !revising && evaluation?.fresh && evaluation.verdict === 'PASS') continue;
    if (state.stage !== gate) return advance(gate);
    if (gate === 'plan' && !await exists(path('map.md'))) { await h.map(project, { run }); return { applied: 'code map' }; }
    const output = path(gateArtifacts[gate]);
    const inputs = {
      spec: { request: idea ?? investigation, investigation, type: state.type, tier: state.tier, template: template('spec.md'), output },
      architecture: { spec: path('spec.md'), request: idea, investigation, template: template('architecture.md'), output },
      plan: { spec: path('spec.md'), architecture, investigation, 'code map': path('map.md'), type: state.type, tier: state.tier,
        configuration: resolve(project, '.project-os/engineering.config.json'), template: template('plan.md'), output }
    }[gate];
    const producer = extra => ({ do: 'spawn', agents: [{ agent: producers[gate], inputs: { ...inputs, ...common, ...extra } }], then: 'next' });
    if (hash === null || revising) return producer(revising ? { revision: 'pass the user\'s /peos:revise feedback for this artifact; if it is not in this session, ask the user for it' } : {});
    if (gate === 'spec' && specSize?.over) return producer({ revision: `merge acceptance criteria that pass or fail together: ${specSize.criteria} found, ${specSize.limit} allowed` });
    // After /peos:retry the cleared findings go back to the producer while the artifact is unchanged.
    const reset = evaluation ? null : await readJson(directory, `evals/${key}.reset.json`);
    if (reset?.verdict === 'FAIL' && reset.subject === hash) return producer({ findings: digest(reset).blocking, 'unmet criteria': digest(reset).unmetCriteria });
    if (evaluation && !evaluation.fresh) {
      const stop = await limit(directory, key, evaluation, { fresh: false });
      if (stop) return stop;
    }
    if (!evaluation || !evaluation.fresh) {
      const previous = evaluation && evaluation.verdict !== 'PASS' ? await readJson(directory, `evals/${key}.json`) : reset;
      const report = path(`pending-eval-${key}.json`);
      const evaluatorInputs = {
        spec: { spec: output, request: idea ?? investigation },
        architecture: { focus: 'architecture', architecture: output, spec: path('spec.md'), request: idea, investigation },
        plan: { plan: output, spec: path('spec.md'), architecture, investigation, 'code map': path('map.md') }
      }[gate];
      return { do: 'spawn', then: 'next', agents: [{ agent: gateEvaluators[gate], inputs: { ...evaluatorInputs, profile, subject: hash, report,
        ...(previous ? { 'previous blocking findings': digest(previous).blocking, round: 'later round: check that these are fixed and nothing broke' } : {}),
        ...(reset?.verdict === 'BLOCKED' ? { 'previously blocked': 'give the user\'s answer about what could not be assessed' } : {}),
        ...(errors[key] ? { 'previous report rejected': errors[key] } : {}) } }] };
    }
    const stop = await limit(directory, key, evaluation);
    if (stop) return stop;
    if (evaluation.verdict === 'BLOCKED') return blockedAction(directory, key);
    if (evaluation.verdict === 'FAIL') {
      const report = await readJson(directory, `evals/${key}.json`);
      return producer({ findings: report ? digest(report).blocking : 'see the recorded evaluation', 'unmet criteria': report ? digest(report).unmetCriteria : [] });
    }
    return { do: 'gate', gates: state.tier === 'standard' ? ['spec', 'plan'] : [gate],
      artifacts: (state.tier === 'standard' ? ['spec', 'plan'] : [gate]).map(name => path(gateArtifacts[name])),
      message: `Approve with /peos:approve${state.tier === 'standard' ? '' : ` ${gate}`}, or request changes with /peos:revise ${state.tier === 'standard' ? '<spec|plan>' : gate} <feedback>.` };
  }

  // Implementation. Small tiers plan inline in task.md.
  const gated = Object.keys(state.gates).length > 0;
  const planFile = gated ? 'plan.md' : 'task.md';
  const source = await readRunFile(directory, planFile);
  if (source === null) {
    if (gated) fail('STATE', 'plan.md is missing although its gate holds.');
    return { do: 'write', artifact: path('task.md'), template: template('task.md'), sources: { investigation },
      message: 'Write task.md with its inline plan step S1; its Verification section names only task-phase check IDs.' };
  }
  const plan = parsePlan(source, { task: !gated });
  if (!plan.steps.length) return { do: 'stop', code: 'PLAN', message: `${planFile} names no steps (S1, S2 …); it must be revised.` };
  const milestones = milestonesOf(plan, state);
  const current = milestones.find(milestone => state.milestones?.[milestone.id] !== 'done' && !milestone.implicit) ?? (milestones[0].implicit ? milestones[0] : null);
  if (!codeStages.includes(state.stage) && state.stage !== 'release') {
    const outcome = await advance('implement');
    if (outcome.applied && !await exists(path('map.md'))) await h.map(project, { run });
    return outcome;
  }
  if (state.stage === 'release') {
    // Code changed after the release stage was reached: its evidence no longer holds.
    const stale = !assessment.checks?.fresh || Object.entries(assessment.evals).some(([key, evaluation]) => !Object.values(gateEvalKeys).includes(key) && !evaluation.fresh);
    if (stale) {
      await rm(path('summary.md'), { force: true });
      const outcome = await advance('verify');
      return outcome.applied ? { applied: 'code changed after release: checks again' } : outcome;
    }
    if (!await exists(path('summary.md'))) {
      const { shortcuts, floorFlags } = await h.changes(project, { run });
      return { do: 'write', artifact: path('summary.md'), template: template('summary.md'),
        sources: { evaluations: path('evals'), checks: path('checks.json'), shortcuts, floorFlags },
        message: 'Write summary.md: what changed, acceptance evidence from the code evaluation criteria, checks, evaluations with rounds and remaining non-blocking findings, shortcuts and accepted floor flags, what was not verified. Readiness: "Not assessed: release check arrives in increment 6".' };
    }
    return { do: 'finished', summary: path('summary.md') };
  }
  const specPath = path(gated ? 'spec.md' : 'task.md');
  const mapPath = path('map.md');
  const checks = checkLines(config);

  // A refactor proves the existing checks pass before anything changes.
  if (state.type === 'refactor') {
    const { baseline } = assessment;
    if (!baseline) {
      if (codeState !== state.baseCodeState) return { do: 'stop', code: 'BASELINE', message: 'The code changed before the refactor baseline was recorded. Restore that state (the user can stash the changes) or start a new run.' };
      return { do: 'run', command: 'record-baseline', args: ['--run', run], timeoutMs: 600000 };
    }
    if (baseline.status !== 'PASS' || baseline.verification !== 'full' || !baseline.matches) {
      return { do: 'stop', code: 'BASELINE', message: 'The existing checks must pass before a refactor starts; show the user which checks fail.' };
    }
  }
  // A new application is described once its walking skeleton exists.
  if (state.type === 'app' && state.configHash && !profile) {
    return { do: 'spawn', then: 'next', agents: [{ agent: 'peos:profiler', inputs: { 'project root': project, template: resolve(toolkit, 'templates/project-profile.md'),
      checks, commit: headCommit(project), 'profile exists': false,
      ...(await exists(resolve(project, 'AGENTS.md')) ? {} : { 'AGENTS.md': `missing: write it from ${resolve(toolkit, 'templates/project-agents.md')}` }),
      ...(await exists(resolve(project, 'CLAUDE.md')) ? {} : { 'CLAUDE.md': 'missing: write it with the single line @AGENTS.md' }) } }] };
  }
  const scope = milestones.length > 1 && current ? milestones.slice(0, milestones.indexOf(current) + 1) : null;
  const implementerInputs = { spec: specPath, plan: path(planFile), architecture, 'code map': mapPath, checks, ...common,
    ...(architecture ? { dependencies: 'install only the dependencies the approved architecture lists, with the project\'s package manager' } : {}) };
  const remaining = current ? current.steps.filter(id => state.steps[id] !== 'done') : [];
  if (remaining.length) {
    if (state.stage !== 'implement') return advance('implement');
    if (remaining.some(id => state.steps[id] !== 'in_progress')) {
      await h.step(project, { run, step: remaining.join(','), status: 'in_progress' });
      return { applied: `steps ${remaining.join(',')} started` };
    }
    return { do: 'spawn', then: 'next --done <the step IDs the implementer reported DONE>', agents: [{ agent: 'peos:implementer',
      inputs: { ...implementerInputs, steps: remaining, ...(scope ? { milestone: current.id } : {}) } }] };
  }

  // Checks on the current code state.
  const recorded = assessment.checks;
  if (!recorded || !recorded.fresh || !recorded.configMatches || recorded.phase !== 'task') {
    if (state.bootstrap && !state.configHash && !config) {
      let result;
      try { result = await h.setup(project); }
      catch (error) { if (error instanceof ToolkitError) return { do: 'stop', code: error.code, message: error.message }; throw error; }
      if (result.config === 'deferred') return { do: 'stop', code: 'SETUP', message: 'The walking skeleton declares no root test command PEOS can detect; the implementer must add one (for example a package.json "test" script).' };
      return { applied: 'configuration derived from the new manifests' };
    }
    const report = await readJson(directory, 'checks.json');
    if (report && report.codeState === null && recorded.configMatches && report.codeStateNote) {
      return { do: 'stop', code: 'UNSTABLE', message: `${report.codeStateNote} A check writes files Git sees (coverage output, a database file): add them to .gitignore, then /peos:continue.` };
    }
    return { do: 'run', command: 'finish', args: ['--run', run], timeoutMs: 600000,
      message: 'Records the task checks; it can take minutes.' };
  }
  if (recorded.status === 'PASS' && recorded.verification !== 'full') return { do: 'run', command: 'finish', args: ['--run', run], timeoutMs: 600000, message: 'Records all task checks; it can take minutes.' };
  if (recorded.status !== 'PASS') {
    const report = await readJson(directory, 'checks.json');
    const failed = (report?.checks ?? []).filter(check => !['PASS', 'SKIPPED'].includes(check.status)).map(check => check.id);
    if ((state.verifyFailures ?? 0) >= 3) return { do: 'stop', code: 'CHECKS', failed, message: `Checks still fail after three attempts: ${failed.join(', ')}. Show the user which checks fail; after a fix by hand, /peos:continue records them again.` };
    return { do: 'spawn', then: 'next', agents: [{ agent: 'peos:implementer',
      inputs: { ...implementerInputs, 'failed checks': failed, note: 'logs are suppressed; rerun these checks yourself' } }] };
  }
  if (state.stage === 'verify') return advance('evaluate');

  // Evaluations of the current code state.
  const change = await h.changes(project, { run });
  const codeKeys = Object.keys(state.evals).filter(key => !Object.values(gateEvalKeys).includes(key));
  const required = state.tier === 'large' ? ['code-acceptance', 'code-quality', 'code-tests'] : ['code-all'];
  const keys = [...new Set([...required, ...(change.securityTriggers.length || state.evals.security ? ['security'] : []), ...codeKeys])];
  const evaluations = keys.map(key => ({ key, evaluation: assessment.evals[key] }));
  for (const { key, evaluation } of evaluations.filter(({ evaluation }) => evaluation)) {
    const stop = await limit(directory, key, evaluation, { fresh: evaluation.fresh });
    if (stop) return stop;
  }
  const failing = evaluations.filter(({ evaluation }) => evaluation?.fresh && evaluation.verdict === 'FAIL');
  // After /peos:retry the cleared findings go back to the implementer while the code is unchanged.
  const resets = {};
  for (const entry of evaluations.filter(({ evaluation }) => !evaluation)) {
    resets[entry.key] = await readJson(directory, `evals/${entry.key}.reset.json`);
    if (resets[entry.key]?.verdict === 'FAIL' && resets[entry.key].subject === change.codeState) failing.push({ ...entry, report: resets[entry.key] });
  }
  const evidenceRound = Boolean(options['evidence-round']) && failing.length > 0;
  const spawn = evaluations.filter(({ key, evaluation }) => (!evaluation && (evidenceRound || !failing.some(entry => entry.key === key))) || (evaluation && !evaluation.fresh) || (evidenceRound && evaluation?.verdict === 'FAIL'));
  const covered = scope ? [...new Set(scope.flatMap(milestone => milestone.steps.flatMap(id => plan.covers[id] ?? [])))] : null;
  if (spawn.length) {
    const agents = [];
    for (const { key, evaluation } of spawn) {
      const previous = evaluation && evaluation.verdict !== 'PASS' ? await readJson(directory, `evals/${key}.json`) : resets[key];
      const failed = failing.some(entry => entry.key === key);
      const shared = { spec: specPath, diff: change.diffPath, checks: path('checks.json'), subject: change.codeState, report: path(`pending-eval-${key}.json`), profile,
        ...(previous ? { 'previous blocking findings': digest(previous).blocking } : {}),
        ...(evidenceRound && failed ? { 'evidence round': `the code did not change; judge only the missing check evidence, keeping the rest of ${path(`evals/${evaluation ? key : `${key}.reset`}.json`)}` } : {}),
        ...(resets[key]?.verdict === 'BLOCKED' ? { 'previously blocked': 'give the user\'s answer about what could not be assessed' } : {}),
        ...(errors[key] ? { 'previous report rejected': errors[key] } : {}) };
      if (key === 'security') agents.push({ agent: 'peos:eval-security', inputs: { ...shared, triggers: change.securityTriggers } });
      else if (key.startsWith('code-')) agents.push({ agent: 'peos:eval-code', ...(['trivial', 'small'].includes(state.tier) ? { model: 'sonnet' } : {}), inputs: { ...shared,
        focus: key.slice('code-'.length), plan: path(planFile), floorFlags: change.floorFlags, shortcuts: change.shortcuts,
        ...(state.type === 'refactor' ? { 'run type': 'refactor', modifiedTests: change.modifiedTests } : {}),
        ...(covered && current !== milestones.at(-1) ? { milestone: current.id, 'criteria in scope': covered, scope: 'report criteria outside this list not_assessed: a later milestone covers them' } : {}) } });
      else return { do: 'stop', code: 'EVALUATOR', message: `No evaluator is known for the recorded evaluation ${key}.` };
    }
    return { do: 'spawn', then: 'next', agents };
  }
  const blocked = evaluations.find(({ evaluation }) => evaluation?.verdict === 'BLOCKED');
  if (blocked) return blockedAction(directory, blocked.key);
  if (failing.length) {
    const findings = [], unmetCriteria = [];
    for (const { key, report: cleared } of failing) {
      const report = cleared ?? await readJson(directory, `evals/${key}.json`);
      if (report) { findings.push(...digest(report).blocking.map(finding => ({ evaluation: key, ...finding }))); unmetCriteria.push(...digest(report).unmetCriteria); }
    }
    return { do: 'spawn', then: 'next', agents: [{ agent: 'peos:implementer', inputs: { ...implementerInputs, findings, 'unmet criteria': [...new Set(unmetCriteria)],
      note: 'If every blocking finding only lacks check evidence and no code needs to change, do not spawn the implementer: call next --evidence-round instead.' } }] };
  }
  // Everything passed on this code state.
  if (state.tier === 'large' && current && !current.implicit) {
    await h.completeMilestone(project, { run, milestone: current.id, final: current === milestones.at(-1) });
    if (current !== milestones.at(-1)) return { applied: `milestone ${current.id} done` };
  }
  try { await h.advance(project, { run, to: 'release' }); }
  catch (error) { if (error instanceof ToolkitError) return { do: 'stop', code: error.code, message: error.message }; throw error; }
  return { applied: 'stage release' };
}

// The third failed round, or the same blocking findings two rounds in a row, is the user's call.
// A stale evaluation (the work changed since) is limited only by its round count.
async function limit(directory, key, evaluation, { fresh = true } = {}) {
  if (evaluation.verdict === 'PASS') return null;
  const report = await readJson(directory, `evals/${key}.json`);
  const previous = await readJson(directory, `evals/${key}.prev.json`);
  const plateau = fresh && evaluation.verdict === 'FAIL' && report?.verdict === 'FAIL' && previous?.verdict === 'FAIL' && signature(previous) === signature(report);
  if (evaluation.round < 3 && !plateau) return null;
  const gate = gateOrder.find(name => gateEvalKeys[name] === key);
  return { do: 'limit', key, round: evaluation.round, plateau, blocking: report ? digest(report).blocking : [],
    message: `Show the blocking findings. Options: /peos:retry ${key} to try again as is,${gate ? ` /peos:revise ${gate} <feedback> to redirect the work,` : ''} or stop.` };
}

// An evaluator could not judge: the user supplies what was missing, then /peos:retry <key>
// runs it again with the answer.
async function blockedAction(directory, key) {
  const report = await readJson(directory, `evals/${key}.json`);
  return { do: 'blocked', key, notAssessed: report?.notAssessed ?? [],
    message: `Report what the evaluator could not assess and ask the user; with the answer, /peos:retry ${key} runs it again.` };
}
