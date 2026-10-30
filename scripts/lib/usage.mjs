import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Token use of one session since a run began: the main transcript plus its subagent
// transcripts (<session>/subagents/*.jsonl). Each model call is counted once even when
// the host splits its message over several lines.
export const usageFile = 'usage.json';
// Starting budgets in total tokens (cache reads included); tuned with measurements later.
export const tierBudgets = { trivial: 1_500_000, small: 3_000_000, standard: 6_000_000, large: 30_000_000 };
const sizeLimit = 64 * 1024 * 1024;

async function transcripts(path) {
  const files = [path];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
  };
  await walk(join(dirname(path), basename(path, '.jsonl'), 'subagents'));
  return files;
}
// Per model call [input, output, cacheWrite, cacheRead], keyed by message id across all
// files: resumed or forked transcripts repeat earlier calls, and a call split over several
// lines may carry partial output counts, so the largest output wins.
export async function sessionCalls(path, sinceMs) {
  const calls = {};
  let bytes = 0;
  for (const file of await transcripts(path)) {
    bytes += (await stat(file).catch(() => ({ size: 0 }))).size;
    if (bytes > sizeLimit) return null;
    for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry?.message?.usage;
      const id = entry?.message?.id;
      if (entry.type !== 'assistant' || !usage || typeof id !== 'string' || !(Date.parse(entry.timestamp) >= sinceMs)) continue;
      const counts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(value => value || 0);
      if (!calls[id] || counts[1] > calls[id][1]) calls[id] = counts;
    }
  }
  return calls;
}
export function totals(calls) {
  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
  for (const [input, output, cacheWrite, cacheRead] of Object.values(calls ?? {})) {
    Object.assign(total, { input: total.input + input, output: total.output + output, cacheWrite: total.cacheWrite + cacheWrite, cacheRead: total.cacheRead + cacheRead, calls: total.calls + 1 });
  }
  return { ...total, total: total.input + total.output + total.cacheWrite + total.cacheRead };
}
export function summarizeUsage(record, tier) {
  if (!record?.calls || !Object.keys(record.calls).length) return null;
  const { total, output, cacheRead, calls } = totals(record.calls);
  const budget = tierBudgets[tier];
  return { total, output, cacheRead, calls, sessions: Object.keys(record.sessions ?? {}).length, budget, overBudget: total > budget };
}
