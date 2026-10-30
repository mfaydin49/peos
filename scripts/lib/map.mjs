import { lstat, open } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fail, ToolkitError } from './cli.mjs';
import { git } from './git.mjs';
import { testPath } from './changes.mjs';

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
  const folders = new Map();
  for (const path of files) {
    const current = await lstat(resolve(project, path)).catch(() => null);
    if (!current?.isFile()) continue;
    const found = await definitions(resolve(project, path), language[extname(path)]);
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
  return { map: lines.join('\n'), folders: folders.size, files: files.length, truncated: omitted + shortened > 0 };
}
