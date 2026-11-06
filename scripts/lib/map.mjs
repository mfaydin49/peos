import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fail, ToolkitError } from './cli.mjs';
import { git } from './git.mjs';
import { testPath } from './changes.mjs';
import { writeAtomic } from './run-state.mjs';

// Code map (idea from dietrichgebert/ponytail, reimplemented): the top-level names each
// source folder defines, so planners and implementers can reuse before writing. Regex per
// language, not a parser: nested and dynamic definitions are missed by design.
const names = {
  js: [/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+(?!extends\b|implements\b)([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:type\s+)?\{([^}]+)\}/gm, /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm],
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
  rs: [/^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+(\w+)/gm],
  rb: [/^(?:class|module)\s+([A-Z]\w*)/gm, /^\s{0,2}def\s+(?:self\.)?(\w+[!?]?)/gm],
  jvm: [/^\s{0,4}(?:public\s+|internal\s+)?(?:(?:abstract|final|data|sealed|open|static|partial)\s+)*(?:class|interface|enum|object|record|fun|struct)\s+(\w+)/gm],
  swift: [/^(?:public\s+|open\s+)?(?:final\s+)?(?:func|class|struct|enum|protocol|actor|extension|typealias)\s+(\w+)/gm],
  php: [/^(?:final\s+|abstract\s+)?(?:function|class|interface|trait|enum)\s+(\w+)/gm]
};
const language = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.py': 'py', '.go': 'go', '.rs': 'rs',
  '.rb': 'rb', '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.cs': 'jvm', '.scala': 'jvm', '.swift': 'swift', '.php': 'php' };
const skipped = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|target|coverage|\.next|\.nuxt|generated|__generated__|Pods|DerivedData|\.project-os|\.git)\//;
const minified = /\.(?:min|bundle|generated|gen|d)\.[a-z]+$/;
const shared = /(?:^|\/)(?:lib|libs|utils?|helpers?|common|shared|core|services?|components|hooks|models?|api|domain)(?:\/|$)/i;
const fileLimit = 4000;
const readLimit = 200 * 1024;
const perFile = 12;
const perFolder = 40;
// The map is kept in the project, for every agent to read: code-map.md, with the names
// each file defines in code-map.json, keyed by the file's size and modification time, so
// only new or changed files are read again and code-map.md is rewritten only when the
// names changed. The folder's own .gitignore keeps both out of Git and the code state.
export const cacheFolder = '.project-os/cache';
export const codeMapPath = `${cacheFolder}/code-map.md`;
const cachePath = `${cacheFolder}/code-map.json`;
// Bump when the patterns or limits above change, so old entries are not reused.
const cacheVersion = 1;
// A file written this recently may change again within the same timestamp; it is read next time.
const settleMs = 2000;

async function realDirectory(path) {
  const current = await lstat(path).catch(() => null);
  return Boolean(current?.isDirectory() && !current.isSymbolicLink());
}
// The map is kept only where PEOS is set up; it never creates .project-os.
async function cacheUsable(project) {
  if (!await realDirectory(resolve(project, '.project-os'))) return false;
  return !await lstat(resolve(project, cacheFolder)).catch(() => null) || realDirectory(resolve(project, cacheFolder));
}
async function loadCache(project) {
  if (!await cacheUsable(project)) return null;
  try {
    const cache = JSON.parse(await readFile(resolve(project, cachePath), 'utf8'));
    return cache?.version === cacheVersion && cache.files && typeof cache.files === 'object' ? cache.files : {};
  } catch { return {}; }
}
async function cacheFile(project, path, text) {
  const folder = resolve(project, cacheFolder);
  await mkdir(folder, { recursive: true });
  const ignore = resolve(folder, '.gitignore');
  if (!await lstat(ignore).catch(() => null)) await writeFile(ignore, '*\n');
  await writeAtomic(resolve(project, path), text);
}

async function definitions(path, kind) {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, readLimit));
    await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8');
    const found = new Set();
    for (const pattern of names[kind]) {
      for (const match of text.matchAll(pattern)) {
        for (const name of match[1].split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(Boolean)) {
          if (!name.startsWith('_') && /^[\w$!?]+$/.test(name)) found.add(name);
        }
      }
    }
    return [...found].slice(0, perFile);
  } finally { await handle.close(); }
}

export async function codeMap(project, budget = 6000) {
  let listed;
  try { listed = git(project, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean); }
  catch (error) {
    if (error instanceof ToolkitError && error.code === 'GIT') fail('MAP', 'Too many files to list for a code map (Git timed out or exceeded its output limit); search the code instead.');
    throw error;
  }
  const files = listed.filter(path => language[extname(path)] && !skipped.test(path) && !minified.test(path) && !testPath.test(path)).slice(0, fileLimit);
  const cached = await loadCache(project);
  const kept = {};
  let read = 0;
  const folders = new Map();
  for (const path of files) {
    const current = await lstat(resolve(project, path)).catch(() => null);
    if (!current?.isFile()) continue;
    const key = `${current.size}:${current.mtimeMs}`;
    let found = cached?.[path]?.key === key ? cached[path].names : null;
    if (!Array.isArray(found)) {
      found = await definitions(resolve(project, path), language[extname(path)]);
      read++;
    }
    if (cached) kept[path] = { key: Date.now() - current.mtimeMs < settleMs ? null : key, names: found };
    if (!found.length) continue;
    const folder = dirname(path) === '.' ? '.' : dirname(path);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(`${path.slice(folder === '.' ? 0 : folder.length + 1)}(${found.join(', ')})`);
  }
  const ordered = [...folders.keys()].sort((a, b) => Number(shared.test(b)) - Number(shared.test(a)) || a.localeCompare(b));
  const lines = [];
  let used = 0, omitted = 0, shortened = 0;
  // A large folder is shortened to what fits rather than dropped whole.
  for (const folder of ordered) {
    const entries = folders.get(folder);
    let line = `${folder}/:`;
    let shown = 0;
    for (const entry of entries.slice(0, perFolder)) {
      if (used + line.length + entry.length + 40 > budget) break;
      line += ` ${entry}`;
      shown++;
    }
    if (!shown) { omitted++; continue; }
    if (shown < entries.length) { line += ` … +${entries.length - shown} file(s)`; shortened++; }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted) lines.push(`… ${omitted} more folder(s) omitted (budget ${budget} characters); search the code for them.`);
  const map = lines.join('\n');
  if (!cached) return { map, folders: folders.size, files: files.length, read, truncated: omitted + shortened > 0, path: null, changed: false };
  if (read || Object.keys(cached).some(path => !Object.hasOwn(kept, path))) await cacheFile(project, cachePath, `${JSON.stringify({ version: cacheVersion, files: kept })}\n`);
  const text = `# Code map\n\nTop-level names per folder (regex-based; nested and dynamic definitions are missed). Kept current by peos-run.\n\n${map}\n`;
  const changed = await readFile(resolve(project, codeMapPath), 'utf8').catch(() => null) !== text;
  if (changed) await cacheFile(project, codeMapPath, text);
  return { map, folders: folders.size, files: files.length, read, truncated: omitted + shortened > 0, path: resolve(project, codeMapPath), changed };
}
