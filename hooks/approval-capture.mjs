// UserPromptSubmit: when the whole prompt is a PEOS decision command, leave a grant
// that the matching peos-run action consumes. Never blocks or alters the prompt.
import { readInput, projectRoot, activeRuns } from './common.mjs';
import { writeGrant } from '../scripts/lib/grants.mjs';
import { basename } from 'node:path';
import { decisionGate, runDirectory } from '../scripts/lib/run-state.mjs';

const name = '[a-z0-9]+(?:-[a-z0-9]+)*';
const patterns = [
  [new RegExp(`^/peos:approve(?:\\s+(spec|architecture|plan)(?:\\s+(${name}))?)?\\s*$`), 'approve'],
  [new RegExp(`^/peos:revise\\s+(spec|architecture|plan)(?:\\s+--run\\s+(${name}))?(?:\\s[\\s\\S]*)?$`), 'revise'],
  [new RegExp(`^/peos:retry\\s+(${name})(?:\\s+(${name}))?\\s*$`), 'reset-eval']
];

try {
  const { input } = await readInput();
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  const project = await projectRoot(input);
  for (const [pattern, action] of patterns) {
    const match = pattern.exec(prompt);
    if (match && project) {
      // Bind the decision to one run: the named one (it must resolve) or the most
      // recently updated unfinished run, which is what the entry skills default to.
      const latest = match[2] ? null : (await activeRuns(project))[0]?.state;
      const run = match[2] ? basename(await runDirectory(project, match[2])) : latest?.run;
      // A bare /peos:approve decides the run's pending gate.
      const target = match[1] ?? (latest && decisionGate(latest));
      if (run && target) await writeGrant(project, { action, target, run, source: 'user-prompt' });
      break;
    }
  }
} catch { /* A missing grant only makes the decision fail closed later. */ }
