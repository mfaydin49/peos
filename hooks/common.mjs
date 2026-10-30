import { readdir, readFile, realpath, stat } from 'node:fs/promises';
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
// The session's transcript as parsed entries; large transcripts are skipped (hooks have seconds).
const transcriptLimit = 64 * 1024 * 1024;
export async function transcriptEntries(path) {
  if (typeof path !== 'string') return [];
  const current = await stat(path).catch(() => null);
  if (!current?.isFile() || current.size > transcriptLimit) return [];
  return (await readFile(path, 'utf8').catch(() => '')).split('\n')
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
// A session works on a run when it ran peos-run for it itself (--run <name>, or init
// --name <name>). Mentions elsewhere (session-resume context, status listings) do not count.
export function sessionRunNames(entries) {
  const names = new Set();
  for (const entry of entries) {
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      const command = block?.type === 'tool_use' && block.name === 'Bash' ? String(block.input?.command ?? '') : '';
      if (!command.includes('peos-run')) continue;
      for (const match of command.matchAll(/--(?:run|name)\s+["']?([a-z0-9]+(?:-[a-z0-9]+)*)["']?(?=\s|$)/g)) names.add(match[1]);
    }
  }
  return names;
}
export function worksOn(names, run) {
  return names.has(run) || names.has(run.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
}
