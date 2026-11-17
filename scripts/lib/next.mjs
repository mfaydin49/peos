// The run's control flow (design peos-next.md): from the state, the run files and the code
// state, apply every bookkeeping step that needs no outside work and return exactly one
// action for the orchestrator. The orchestrator only loops: next → do it → next.
import { createHash } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ToolkitError } from './cli.mjs';
import { loadConfig } from './config.mjs';
import { digest, signature } from './eval-report.mjs';
import { headCommit } from './git.mjs';
import { codeMapPath } from './map.mjs';
import { decisionGroup, designRequested, gateArtifacts, gateEvalKeys, gateOrder, readRunFile } from './run-state.mjs';
import { runningPreview } from './ui.mjs';

const toolkit = fileURLToPath(new URL('../../', import.meta.url));
const template = name => resolve(toolkit, 'templates/run', name);
const producers = { spec: 'peos:spec-writer', architecture: 'peos:architect', design: 'peos:designer', plan: 'peos:planner' };
const gateEvaluators = { spec: 'peos:eval-spec', architecture: 'peos:eval-plan', design: 'peos:eval-design', plan: 'peos:eval-plan' };
const gateStages = ['intake', ...gateOrder];
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
// Digests of each plan step (its section and the text of the criteria it covers) and of
// each milestone (its step list), recorded at plan approval: a re-approved plan keeps the
// work whose digest did not change (eval-economy.md).
export function planDigest(planSource, specSource, architectureSource = null) {
  const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  // A criterion is its whole list item, continuation lines included.
  const criteria = Object.fromEntries([...(specSource ?? '').matchAll(/^\s*-\s*(AC-\d+)\s*:([^\n]*(?:\n(?![ \t]*(?:[-*#]|\d+\.|$))[^\n]*)*)/gm)]
    .map(([, id, text]) => [id, text.replace(/\s+/g, ' ').trim()]));
  // A changed architecture changes how every step is built.
  const architecture = architectureSource === null ? '' : sha(architectureSource);
  const plan = parsePlan(planSource);
  const steps = {};
  for (const section of planSource.split(/^###\s+/m).slice(1)) {
    const id = /^(S[1-9]\d*)\b/.exec(section)?.[1];
    if (!id || Object.hasOwn(steps, id)) continue;
    const body = section.split(/^##\s/m)[0].trim();
    steps[id] = sha(`${architecture}\0${body}\0${plan.covers[id].map(criterion => `${criterion}: ${criteria[criterion] ?? ''}`).join('\n')}`);
  }
  const members = Object.fromEntries(milestonesOf(plan, { tier: 'large' }).map(milestone => [milestone.id, milestone.steps]));
  const milestones = Object.fromEntries(Object.entries(members).map(([id, list]) => [id, sha(list.join(','))]));
  return { steps, milestones, members };
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
  const design = state.gates.design ? path('design.md') : undefined;
  const preview = path('design-preview.html');
  const mapPath = resolve(project, codeMapPath);
  // A refused transition is the user's to resolve; its reason is the message.
  const advance = async to => {
    try { await h.advance(project, { run, to }); }
    catch (error) { if (error instanceof ToolkitError) return { do: 'stop', code: error.code, message: error.message }; throw error; }
    return { applied: `stage ${to}` };
  };

  if (state.stage === 'done') return { do: 'finished', summary: path('summary.md') };
  if (state.stage === 'stopped') return { do: 'stop', code: 'STOPPED', message: 'The run was stopped; start a new run.' };

  // The design gate follows what the spec asks for until implementation starts (design-gate.md).
  if (['standard', 'large'].includes(state.tier) && gateStages.includes(state.stage)) {
    const wanted = designRequested(await readRunFile(directory, 'spec.md'));
    if (wanted !== Boolean(design) && (wanted || !assessment.gates.design.fresh) && (await h.designGate(project, { run })).changed) {
      return { applied: wanted ? 'design gate added' : 'design gate removed' };
    }
  }

  // Gates, in order. A gate that is not the last of its decision group passes on a PASS
  // and is decided with the group's last gate: everything with the plan on a standard
  // run; spec, architecture and design together, then the plan, on a large run.
  for (const gate of gateOrder.filter(name => Object.hasOwn(state.gates, name))) {
    if (assessment.gates[gate].fresh) continue;
    const key = gateEvalKeys[gate];
    const evaluation = assessment.evals[key];
    const hash = artifacts[gate];
    const revising = state.gates[gate].status === 'revision_requested' && (hash === null || state.gates[gate].artifactHash === hash);
    const group = decisionGroup(state, gate);
    if (gate !== group.at(-1) && !revising && evaluation?.fresh && evaluation.verdict === 'PASS') continue;
    if (state.stage !== gate) return advance(gate);
    if (gate === 'plan' && (await h.map(project)).changed) return { applied: 'code map' };
    const output = path(gateArtifacts[gate]);
    const inputs = {
      spec: { request: idea ?? investigation, investigation, type: state.type, tier: state.tier, template: template('spec.md'), output },
      architecture: { spec: path('spec.md'), request: idea, investigation, template: template('architecture.md'), output },
      design: { spec: path('spec.md'), architecture, request: idea, investigation, 'design references': config?.references.design?.length ? config.references.design : undefined,
        template: template('design.md'), output, preview },
      plan: { spec: path('spec.md'), architecture, design, investigation, 'code map': mapPath, type: state.type, tier: state.tier,
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
        // The design is judged as rendered: peos-run serves the preview file for the evaluator.
        design: gate !== 'design' ? null : { design: output, preview, 'preview url': (await h.serveDesign(project, { run })).url ?? 'unavailable: judge design.md and the preview source, and report mode degraded',
          spec: path('spec.md'), architecture, 'design references': config?.references.design?.length ? config.references.design : undefined },
        plan: { plan: output, spec: path('spec.md'), architecture, design, investigation, 'code map': mapPath }
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
    const decided = group.filter(name => !assessment.gates[name].fresh);
    const shown = decided.includes('design') && await exists(preview);
    return { do: 'gate', gates: decided,
      artifacts: [...decided.map(name => path(gateArtifacts[name])), ...(shown ? [preview] : [])],
      message: `Approve with /peos:approve${decided.length > 1 ? '' : ` ${gate}`}, or request changes with /peos:revise ${decided.length > 1 ? `<${decided.join('|')}>` : gate} <feedback>.${decided.includes('architecture') ? ' Approving also consents to installing the dependencies the architecture lists, and only those.' : ''}${shown ? ` Open ${preview} in a browser to see the design.` : ''}` };
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
    return advance('implement');
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
      const { shortcuts, floorFlags, uiTriggers } = await h.changes(project, { run });
      const capture = (await readJson(directory, 'checks.json'))?.ui;
      // A changed interface nobody looked at is said plainly (eval-ui.md §5.3).
      const ui = state.evals.ui ? { evaluation: path('evals/ui.json'), ...(capture?.status === 'captured' ? { screenshots: capture.manifest } : {}) }
        : uiTriggers?.length ? { 'not verified': uiNotVerified(config, capture), triggers: uiTriggers } : undefined;
      return { do: 'write', artifact: path('summary.md'), template: template('summary.md'),
        sources: { evaluations: path('evals'), checks: path('checks.json'), shortcuts, floorFlags, ui,
          carried: Object.entries(state.evals).filter(([, evaluation]) => evaluation.carried).map(([key]) => key) },
        message: `Write summary.md: what changed, acceptance evidence from the code evaluation criteria, checks, evaluations with rounds and remaining non-blocking findings (name each carried evaluation as carried over a change that needed no evaluator), ${ui ? (ui.evaluation ? 'the user interface observed (screens, states, viewports, with relative links to the screenshots when there are any), ' : 'the user interface as not verified, first under Not verified, with its reason and fix, ') : ''}shortcuts and accepted floor flags, what was not verified. Readiness: "Not assessed: release check arrives in increment 6".` };
    }
    return { do: 'finished', summary: path('summary.md') };
  }
  const specPath = path(gated ? 'spec.md' : 'task.md');
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
  // The last open milestone judges every criterion, also when later ones were kept done
  // by a plan re-approval.
  const final = !current || milestones.every(milestone => milestone === current || state.milestones?.[milestone.id] === 'done');
  const implementerInputs = { spec: specPath, plan: path(planFile), architecture, design, 'code map': mapPath, checks, ...common,
    ...(architecture ? { dependencies: 'install only the dependencies the approved architecture lists, with the project\'s package manager' } : {}) };
  const remaining = current ? current.steps.filter(id => state.steps[id] !== 'done') : [];
  if (remaining.length) {
    if (state.stage !== 'implement') return advance('implement');
    if (remaining.some(id => state.steps[id] !== 'in_progress')) {
      await h.step(project, { run, step: remaining.join(','), status: 'in_progress' });
      return { applied: `steps ${remaining.join(',')} started` };
    }
    // The implementer works from the current map: earlier steps and milestones add names.
    if ((await h.map(project)).changed) return { applied: 'code map' };
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
    if ((await h.map(project)).changed) return { applied: 'code map' };
    return { do: 'spawn', then: 'next', agents: [{ agent: 'peos:implementer',
      inputs: { ...implementerInputs, 'failed checks': failed, note: 'logs are suppressed; rerun these checks yourself' } }] };
  }
  if (state.stage === 'verify') return advance('evaluate');

  // Evaluations of the current code state.
  const change = await h.changes(project, { run });
  const codeKeys = Object.keys(state.evals).filter(key => !Object.values(gateEvalKeys).includes(key));
  const required = state.tier === 'large' ? ['code-acceptance', 'code-quality', 'code-tests'] : ['code-all'];
  // The interface is evaluated when the change touches it and something can show it:
  // screenshots from a ui-capture check, or the configured local preview (eval-ui.md §4–5).
  const capture = (await readJson(directory, 'checks.json'))?.ui;
  const screenshots = capture?.status === 'captured' ? capture : null;
  const uiSource = screenshots ? 'capture' : config?.preview ? 'preview' : null;
  const ui = state.evals.ui || ((change.uiTriggers.length || state.evalBases?.ui) && uiSource) ? ['ui'] : [];
  const keys = [...new Set([...required, ...(change.securityTriggers.length || state.evals.security || state.evalBases?.security ? ['security'] : []), ...ui, ...codeKeys])];
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
  let live = null;
  if (spawn.some(({ key }) => key === 'ui')) {
    if (!uiSource) return { do: 'stop', code: 'UI', message: `The interface was evaluated earlier, but nothing can show it now: ${uiNotVerified(config, capture)}.` };
    // The preview is started by peos-run, which runs only the configured command.
    if (uiSource === 'preview' && !(live = await runningPreview(directory))) {
      return { do: 'run', command: 'preview-start', args: ['--run', run], timeoutMs: config.preview.timeoutMs + 30000, message: 'Starts the local preview the UI evaluator looks at.' };
    }
  }
  if (spawn.length) {
    // Delta evaluation (eval-economy.md): an evaluation with a snapshot judges only the
    // change since it; one kept as a base at a milestone boundary or plan re-approval does
    // too, except the acceptance evaluation of the last milestone, which judges everything.
    // A base judged another scope or plan, so only security carries from one.
    const deltas = new Map();
    const deltaSince = async tree => {
      if (!deltas.has(tree)) deltas.set(tree, await h.delta(project, { run, since: tree }));
      return deltas.get(tree);
    };
    const agents = [];
    for (const { key, evaluation } of spawn) {
      const base = evidenceRound ? null
        : evaluation ? (!evaluation.fresh && evaluation.tree ? { tree: evaluation.tree, report: path(`evals/${key}.json`), passed: evaluation.verdict === 'PASS' } : null)
        : state.evalBases?.[key] && !(['code-acceptance', 'code-all'].includes(key) && final) ? { tree: state.evalBases[key].tree, report: path(`evals/${key}.base.json`), passed: true, kept: true } : null;
      let basis = null;
      if (base) {
        const since = await deltaSince(base.tree);
        // Nothing changed, or nothing security-relevant for the security evaluation: the PASS holds.
        if (since.tree && base.passed && (key === 'security' ? !since.securityTriggers.length : since.empty && !base.kept)) {
          // A carry that fails (Git slow or the code moving) falls back to an evaluator.
          try { await h.carryEval(project, { run, key }); return { applied: `carried ${key}` }; }
          catch (error) { if (!(error instanceof ToolkitError)) throw error; }
        }
        // A delta over half of the whole change is no saving: judge everything.
        if (since.tree && !since.empty && since.bytes <= change.diffBytes / 2) basis = { ...since, report: base.report };
      }
      const previous = evaluation && evaluation.verdict !== 'PASS' ? await readJson(directory, `evals/${key}.json`) : resets[key];
      const failed = failing.some(entry => entry.key === key);
      const shared = { spec: specPath, diff: change.diffPath, checks: path('checks.json'), subject: change.codeState, report: path(`pending-eval-${key}.json`), profile,
        ...(basis ? { basis: 'delta: judge the change since your previous report (rules/evaluation.md, "Delta evaluation"); the full diff is context',
          'delta diff': basis.deltaPath, 'previous report': basis.report } : {}),
        ...(previous ? { 'previous blocking findings': digest(previous).blocking } : {}),
        ...(evidenceRound && failed ? { 'evidence round': `the code did not change; judge only the missing check evidence, keeping the rest of ${path(`evals/${evaluation ? key : `${key}.reset`}.json`)}` } : {}),
        ...(resets[key]?.verdict === 'BLOCKED' ? { 'previously blocked': 'give the user\'s answer about what could not be assessed' } : {}),
        ...(errors[key] ? { 'previous report rejected': errors[key] } : {}) };
      if (key === 'security') agents.push({ agent: 'peos:eval-security', inputs: { ...shared, triggers: basis ? basis.securityTriggers : change.securityTriggers } });
      else if (key === 'ui') agents.push({ agent: 'peos:eval-ui', inputs: { ...shared, plan: path(planFile), design, triggers: basis ? basis.uiTriggers : change.uiTriggers,
        ...(screenshots ? { screenshots: screenshots.manifest }
          : { preview: live.url, viewports: config.preview.viewports.map(({ name, width, height }) => `${name} ${width}x${height}`), 'color schemes': config.preview.colorSchemes }),
        ...(covered && !final ? { milestone: current.id, 'criteria in scope': covered, scope: 'report criteria outside this list not_assessed: a later milestone covers them' } : {}) } });
      else if (key.startsWith('code-')) agents.push({ agent: 'peos:eval-code', ...(['trivial', 'small'].includes(state.tier) ? { model: 'sonnet' } : {}), inputs: { ...shared,
        focus: key.slice('code-'.length), plan: path(planFile), design, floorFlags: change.floorFlags, shortcuts: change.shortcuts,
        ...(state.type === 'refactor' ? { 'run type': 'refactor', modifiedTests: change.modifiedTests } : {}),
        ...(covered && !final ? { milestone: current.id, 'criteria in scope': covered, scope: 'report criteria outside this list not_assessed: a later milestone covers them' } : {}) } });
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
    if ((await h.map(project)).changed) return { applied: 'code map' };
    return { do: 'spawn', then: 'next', agents: [{ agent: 'peos:implementer', inputs: { ...implementerInputs, findings, 'unmet criteria': [...new Set(unmetCriteria)],
      note: 'If every blocking finding only lacks check evidence and no code needs to change, do not spawn the implementer: call next --evidence-round instead.' } }] };
  }
  // Everything passed on this code state.
  if (state.tier === 'large' && current && !current.implicit) {
    await h.completeMilestone(project, { run, milestone: current.id, final });
    if (!final) return { applied: `milestone ${current.id} done` };
  }
  try { await h.advance(project, { run, to: 'release' }); }
  catch (error) { if (error instanceof ToolkitError) return { do: 'stop', code: error.code, message: error.message }; throw error; }
  return { applied: 'stage release' };
}

// Why a changed interface has no UI evaluation, with the fix.
function uiNotVerified(config, capture) {
  if (capture && capture.status !== 'captured') return `the ui-capture check gave no usable screenshots (${capture.reason})`;
  if (config?.checks.some(check => check.kind === 'ui-capture')) return 'the ui-capture check did not run with the current checks (it needs the task phase)';
  return 'no ui-capture check or preview is configured; add one to .project-os/engineering.config.json (docs/design/eval-ui.md §5)';
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
