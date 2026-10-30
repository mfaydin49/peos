import { readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runsPath, runDirectory, readState } from '../scripts/lib/run-state.mjs';

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return { raw, input: JSON.parse(raw) }; } catch { return { raw, input: null }; }
}
export async function projectRoot(input) {
  const candidate = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
  if (!candidate) return null;
  try { return await realpath(candidate); } catch { return null; }
}
// minimal keeps only the guards that protect decisions and state; invalid values mean standard.
export function profile() {
  const value = process.env.CLAUDE_PLUGIN_OPTION_HOOK_PROFILE;
  return ['minimal', 'standard', 'strict'].includes(value) ? value : 'standard';
}
export function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
// Unfinished runs, most recently updated first; unreadable runs are skipped.
export async function activeRuns(project) {
  let names;
  try { names = (await readdir(resolve(project, runsPath))).filter(name => !name.startsWith('.')); }
  catch { return []; }
  const runs = [];
  for (const name of names) {
    try {
      const directory = await runDirectory(project, name);
      const state = await readState(directory);
      if (!['done', 'stopped'].includes(state.stage)) runs.push({ directory, state });
    } catch { /* not a readable run */ }
  }
  return runs.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}
