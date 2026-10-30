// Stop: if the active run's gate artifact was just written but never evaluated, block
// the stop once so the orchestrator evaluates it (or says why not) before handing back.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readInput, projectRoot, profile, activeRuns, emit } from './common.mjs';
import { artifactHash, gateArtifacts, gateEvalKeys } from '../scripts/lib/run-state.mjs';

const recentMs = 60 * 60 * 1000;
// Only the session that worked on the run is reminded; other sessions in the project are left alone.
async function sessionWorkedOn(path, run) {
  if (typeof path !== 'string') return false;
  return (await readFile(path, 'utf8').catch(() => '')).includes(run);
}

try {
  const { input } = await readInput();
  const project = await projectRoot(input);
  if (profile() !== 'minimal' && input && !input.stop_hook_active && project) {
    const [active] = await activeRuns(project);
    const gate = active?.state.stage;
    if (active && Object.hasOwn(active.state.gates, gate) && active.state.gates[gate].status !== 'approved'
      && await sessionWorkedOn(input.transcript_path, active.state.run)) {
      const artifact = resolve(active.directory, gateArtifacts[gate]);
      const hash = await artifactHash(active.directory, gate);
      const recent = hash && Date.now() - (await stat(artifact)).mtimeMs < recentMs;
      const evaluated = active.state.evals[gateEvalKeys[gate]]?.subject === hash;
      // Block at most once per artifact version, even if the host omits stop_hook_active.
      const marker = resolve(active.directory, '.stop-block');
      const already = await readFile(marker, 'utf8').catch(() => '') === hash;
      if (recent && !evaluated && !already) {
        await writeFile(marker, hash);
        emit({ decision: 'block', reason: `PEOS run ${active.state.run}: ${gateArtifacts[gate]} was written but has no evaluation for its current content. Run the ${gateEvalKeys[gate]} evaluator and record it with peos-run record-eval, or tell the user why it cannot be evaluated.` });
      }
    }
  }
} catch { /* Never trap the session because of a hook failure. */ }
