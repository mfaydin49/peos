import { main, parseArgs, projectDirectory, fail, requirePlatform } from './lib/cli.mjs';
import { loadConfig, resolveReferences } from './lib/config.mjs';
import { runCheck } from './lib/process.mjs';

await main(async () => {
  const options = parseArgs(process.argv.slice(2), ['project', 'phase', 'checks']);
  requirePlatform();
  const project = await projectDirectory(options.project);
  if (!['task', 'release'].includes(options.phase)) fail('INVOCATION', '--phase must be task or release.');
  const config = await loadConfig(project);
  const applicable = config.checks.filter(check => check.phases.includes(options.phase));
  if (!applicable.length) fail('SELECTION', 'The phase has no configured checks.');
  // JSON array avoids ambiguity for IDs containing commas or whitespace.
  let selected = applicable.map(check => check.id);
  if (options.checks !== undefined) {
    try { selected = JSON.parse(options.checks); } catch { fail('SELECTION', '--checks must be a non-empty JSON array of IDs.'); }
    if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string' || !id.trim()) || new Set(selected).size !== selected.length) fail('SELECTION', '--checks must be a non-empty JSON array of unique IDs.');
    if (selected.some(id => !config.checks.some(check => check.id === id))) fail('SELECTION', 'Unknown check ID.');
    if (selected.some(id => !applicable.some(check => check.id === id))) fail('SELECTION', 'Selected check ID is outside the requested phase.');
  }
  const omittedRequiredChecks = applicable.filter(check => check.required && !selected.includes(check.id)).map(check => check.id);
  const controller = new AbortController();
  const onInt = () => controller.abort('SIGINT');
  const onTerm = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const results = [];
  try {
    for (const check of config.checks) {
      const inPhase = check.phases.includes(options.phase);
      if (!inPhase || !selected.includes(check.id)) {
        results.push({ id: check.id, required: check.required, status: 'SKIPPED', exitCode: null, durationMs: 0,
          reason: inPhase ? 'Intentionally omitted from targeted verification.' : 'Outside selected phase.' });
      } else results.push(await runCheck(check, project, controller.signal));
    }
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  const failed = results.some(check => selected.includes(check.id) && check.required && check.status !== 'PASS');
  const interrupted = controller.signal.aborted;
  const verification = options.checks === undefined ? 'full' : 'partial';
  const report = { reportVersion: 1, kind: 'automated-verification', project, projectName: config.projectName,
    phase: options.phase, verification, selectedChecks: selected, omittedRequiredChecks,
    status: interrupted ? 'BLOCKED' : failed ? (results.some(r => r.required && r.status === 'FAIL') ? 'FAIL' : 'BLOCKED') : 'PASS',
    scope: verification === 'partial' ? 'Selected required checks only; whole phase not established.' : 'Required automated phase checks only; not release readiness.',
    interrupted, references: resolveReferences(config, project), checks: results,
    manualRequirements: config.manualChecks.filter(check => check.phases.includes(options.phase)).map(check => ({ ...check, evidence: 'NOT_ASSESSED' }))
  };
  return { report, exitCode: interrupted ? (controller.signal.reason === 'SIGINT' ? 130 : 143) : failed ? 1 : 0 };
}, report => [
  `${report.status} — ${report.verification} automated ${report.phase} verification for ${JSON.stringify(report.projectName)}`,
  report.scope,
  ...report.checks.map(check => `${check.status} ${JSON.stringify(check.id)} (${check.durationMs} ms${check.exitCode === null ? '' : `, exit ${check.exitCode}`}): ${check.reason || 'Succeeded.'}${!check.required ? ' [optional]' : ''}`),
  ...(report.omittedRequiredChecks.length ? [`Omitted required checks: ${JSON.stringify(report.omittedRequiredChecks)}`] : []),
  ...report.manualRequirements.map(check => `Manual evidence NOT ASSESSED: ${JSON.stringify(check.id)}${check.required ? ' [required]' : ' [optional]'}`)
].join('\n'));
