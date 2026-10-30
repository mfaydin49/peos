// SessionStart: remind the new session of unfinished runs in one line each.
import { readInput, projectRoot, profile, activeRuns, emit } from './common.mjs';

try {
  const { input } = await readInput();
  const project = await projectRoot(input);
  const runs = profile() === 'minimal' || !project ? [] : (await activeRuns(project)).slice(0, 3);
  if (runs.length) {
    const lines = runs.map(({ state }) => {
      const pending = Object.entries(state.gates).find(([, gate]) => gate.status !== 'approved')?.[0];
      return `- ${state.run} (${state.type}/${state.tier}) at ${state.stage}${pending ? `; next gate: ${pending}` : ''}`;
    });
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
      `Unfinished PEOS runs in this project:\n${lines.join('\n')}\nThe user can resume with /peos:continue or inspect with /peos:status. Gate decisions are the user's.` } });
  }
} catch { /* Context is a convenience; never fail the session start. */ }
