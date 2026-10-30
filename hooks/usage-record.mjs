// Stop: record this session's token use for the run it is working on in <run>/usage.json,
// so status can show cost against the tier budget. Informational; never blocks.
import { basename, resolve } from 'node:path';
import { readInput, projectRoot, profile, activeRuns, transcriptEntries, sessionRunNames, worksOn } from './common.mjs';
import { readRunFile, writeJsonAtomic } from '../scripts/lib/run-state.mjs';
import { sessionCalls, usageFile } from '../scripts/lib/usage.mjs';

// Work after the release stage is reached (the summary) still counts for a while; later
// unrelated work in the same session does not.
const releaseTailMs = 15 * 60 * 1000;

// No state lock: only this hook writes usage.json, and a killed hook must never leave a
// lock that stops peos-run. Concurrent sessions can lose one update until their next stop.
try {
  const { input } = await readInput();
  const project = await projectRoot(input);
  const path = input?.transcript_path;
  if (profile() !== 'minimal' && project && typeof path === 'string') {
    const runs = await activeRuns(project);
    const names = runs.length ? sessionRunNames(await transcriptEntries(path)) : new Set();
    const active = runs.find(({ state }) => worksOn(names, state.run));
    if (active) {
      const { state, directory } = active;
      const until = state.stage === 'release' ? Date.parse(state.updatedAt) + releaseTailMs : Infinity;
      const calls = Date.now() <= until ? await sessionCalls(path, Date.parse(state.createdAt)) : null;
      if (calls && Object.keys(calls).length) {
        let record;
        try { record = JSON.parse(await readRunFile(directory, usageFile) ?? '{}'); } catch { record = {}; }
        const merged = { ...(record?.calls ?? {}) };
        for (const [id, counts] of Object.entries(calls)) if (!merged[id] || counts[1] > merged[id][1]) merged[id] = counts;
        const sessions = { ...(record?.sessions ?? {}), [basename(path, '.jsonl')]: new Date().toISOString() };
        await writeJsonAtomic(resolve(directory, usageFile), { schemaVersion: 2, sessions, calls: merged });
      }
    }
  }
} catch { /* Usage is informational; a failure must not affect the session. */ }
