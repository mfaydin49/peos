// Stop: if the active run's gate artifact was just written but never evaluated, block
// the stop once so the orchestrator evaluates it (or says why not) before handing back.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readInput, projectRoot, profile, activeRuns, emit, transcriptEntries, sessionRunNames, worksOn } from './common.mjs';
import { artifactHash, gateArtifacts, gateEvalKeys } from '../scripts/lib/run-state.mjs';

const recentMs = 60 * 60 * 1000;
// Hosts may run agents in the background: the turn ends while the evaluator works and
// its result arrives later as a hand-back. An evaluator launched in the background after
// the artifact was written and not yet handed back is still pending, so stopping is not
// a skipped step. A foreground result means the evaluator has finished.
function evaluatorPending(entries, agent, sinceMs) {
  const launched = new Map();
  const handedBack = new Set();
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (entry?.type === 'user' && typeof content === 'string') {
      for (const match of content.matchAll(/<agent-message from="([\w-]+)"/g)) handedBack.add(match[1]);
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === 'assistant' && block?.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)
        && block.input?.subagent_type === agent && Date.parse(entry.timestamp) >= sinceMs) launched.set(block.id, null);
      if (entry.type === 'user' && block?.type === 'tool_result' && launched.has(block.tool_use_id)) {
        const result = JSON.stringify(block.content);
        const background = /Async agent launched|working in the background/.test(result);
        launched.set(block.tool_use_id, background ? /agentId:\s*([\w-]+)/.exec(result)?.[1] ?? 'done' : 'done');
      }
    }
  }
  return [...launched.values()].some(result => result === null || (result !== 'done' && !handedBack.has(result)));
}

try {
  const { input } = await readInput();
  const project = await projectRoot(input);
  if (profile() !== 'minimal' && input && !input.stop_hook_active && project) {
    const runs = await activeRuns(project);
    // Only the session that worked on a run is reminded; other sessions are left alone.
    const entries = runs.length ? await transcriptEntries(input.transcript_path) : [];
    const names = sessionRunNames(entries);
    const active = runs.find(({ state }) => worksOn(names, state.run));
    const gate = active?.state.stage;
    if (active && Object.hasOwn(active.state.gates, gate) && active.state.gates[gate].status !== 'approved') {
      const artifact = resolve(active.directory, gateArtifacts[gate]);
      const hash = await artifactHash(active.directory, gate);
      const written = hash ? (await stat(artifact)).mtimeMs : 0;
      const recent = hash && Date.now() - written < recentMs;
      const evaluated = active.state.evals[gateEvalKeys[gate]]?.subject === hash;
      // Block at most once per artifact version, even if the host omits stop_hook_active.
      const marker = resolve(active.directory, '.stop-block');
      const already = await readFile(marker, 'utf8').catch(() => '') === hash;
      if (recent && !evaluated && !already && !evaluatorPending(entries, `peos:eval-${gate}`, written - 2000)) {
        await writeFile(marker, hash);
        emit({ decision: 'block', reason: `PEOS run ${active.state.run}: ${gateArtifacts[gate]} was written but has no evaluation for its current content. Run the ${gateEvalKeys[gate]} evaluator and record it with peos-run record-eval, or tell the user why it cannot be evaluated.` });
      }
    }
  }
} catch { /* Never trap the session because of a hook failure. */ }
