import { lstat, open, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git } from './git.mjs';

// Filename hints for review; never a secret scan or migration safety evidence.
export function categories(paths) {
  const result = new Set();
  for (const path of paths) {
    if (/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials[^/]*|secrets?[^/]*)$/i.test(path)) result.add('potentially-sensitive');
    if (/(^|\/)(migrations?)(\/|$)/i.test(path) || /migration/i.test(path)) result.add('migration');
    if (/schema|\.sql$|\.prisma$|\.graphql$/i.test(path)) result.add('schema');
    if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(?:\.lock)?|composer\.(json|lock))$/i.test(path)) result.add('dependency');
    if (/(^|\/)(\.github|\.agents|\.project-os|scripts|\.husky)(\/|$)|(^|\/)(AGENTS(?:\.override)?\.md|Dockerfile|Makefile|[^/]*config[^/]*)$/i.test(path)) result.add('tooling');
  }
  return [...result].sort();
}

// Design §9 security triggers. Path categories and added lines in non-test files decide
// whether the security evaluator runs; a match is a reason to look, not a finding.
const pathTriggers = { 'potentially-sensitive': 'secrets', dependency: 'dependencies', migration: 'database', schema: 'database' };
const contentTriggers = {
  authentication: /\b(?:authenticat\w*|authoriz\w*|auth[nz]?|login|logout|jwt|oauth\w*|passw(?:or)?d|permissions?|access[_-]?control)\b/i,
  'user-input': /\b(?:req\.(?:body|query|params|headers)|request\.(?:args|form|json|data|files|GET|POST)|process\.argv|sys\.argv|os\.Args|readline|FormData|URLSearchParams|searchParams|Scanner\s*\(|UITextField|EditText|@RequestParam|@RequestBody)|\$_(?:GET|POST|REQUEST)|\binput\s*\(/,
  database: /\.(?:query|execute|raw)\s*\(|\b(?:prisma|knex|sequelize|mongoose|sqlite3?|psycopg2?|sqlalchemy|gorm|CoreData|Room)\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:\*|INTO|FROM|\w+\s+SET)/,
  'file-system': /\b(?:fs\.(?:\w*[Ww]rite\w*|\w*[Rr]ead\w*|unlink\w*|rm\w*|rename\w*|mkdir\w*|chmod\w*|createReadStream|createWriteStream)|readFile\w*|writeFile\w*|os\.(?:remove|unlink|makedirs|rename|Open|Create|Remove)|shutil\.\w+|FileManager|Files\.\w+|new File\s*\(|ioutil\.\w+)|\bopen\s*\([^)]*['"][rwa]b?\+?['"]/,
  'external-api': /\b(?:fetch\s*\(|axios|https?\.(?:request|get)|http\.(?:Get|Post|NewRequest)|requests\.\w+|httpx|urllib|XMLHttpRequest|WebSocket|URLSession|OkHttp|Retrofit)/,
  cryptography: /\b(?:crypto|createHash|createHmac|createCipher\w*|bcrypt|argon2|scrypt|hashlib|randomBytes|jwt\.sign|CryptoKit|SecKey|MessageDigest|Cipher\.getInstance)\b/,
  secrets: /\b(?:api[_-]?keys?|secrets?|private[_-]?keys?|access[_-]?tokens?|client[_-]?secret)\b|BEGIN [A-Z ]*PRIVATE KEY/i,
  'code-execution': /\b(?:child_process|execSync|execFile\w*|exec\s*\(|spawn\s*\(|eval\s*\(|new Function\s*\(|subprocess|os\.system|Popen|exec\.Command|ProcessBuilder|Process\s*\(\)|Runtime\.getRuntime)/
};
// Test code and test data across common layouts: directories (tests/, spec/, __tests__/,
// __snapshots__/, testdata/, androidTest/, FooTests/), file names (foo.test.js, test_foo.py,
// foo_test.go, FooTest.java, FooTests.swift) and recorded outputs (.snap, .golden).
const testPath = /(?:^|\/)(?:[Tt]ests?|__tests__|[Ss]pecs?|__snapshots__|testdata|androidTest|[A-Za-z0-9]+Tests?)\/|(?:^|\/)test_[^/]+\.py$|[._-](?:test|spec)\.[A-Za-z0-9]+$|_test\.go$|(?:Test|Tests|Spec)\.(?:java|kt|swift|cs|scala|m)$|\.(?:snap|golden)$/;
const diffLimit = 512 * 1024;
const fileLimit = 256 * 1024;
const exclude = ':(exclude).project-os/runs';
const header = path => JSON.stringify(path);

// A file shown in full: regular text files only. Symlinks are shown as links (their target
// may lie outside the project), and special or binary files are described, not read.
async function fullContent(project, path) {
  const absolute = resolve(project, path);
  const current = await lstat(absolute).catch(() => null);
  if (!current) return '(deleted)';
  if (current.isSymbolicLink()) return `(symlink -> ${JSON.stringify(await readlink(absolute))})`;
  if (!current.isFile()) return '(not a regular file)';
  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(current.size, fileLimit));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.includes(0)) return `(binary file, ${current.size} bytes)`;
    const text = buffer.toString('utf8');
    return `${text.split('\n').map(line => `+${line}`).join('\n')}${current.size > fileLimit ? `\n(file truncated at ${fileLimit} bytes)` : ''}`;
  } finally { await handle.close(); }
}

/**
 * Net working-tree changes against the run's base commit (what tests and evaluators
 * see), excluding run files: tracked edits, untracked files, and files hidden by the
 * assume-unchanged or skip-worktree index flags.
 */
export async function codeChanges(project, base) {
  const list = raw => raw.split('\0').filter(Boolean);
  const tracked = list(git(project, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, '--', '.', exclude]));
  const files = [];
  for (let i = 0; i < tracked.length; i += 2) files.push({ status: tracked[i], path: tracked[i + 1] });
  const extra = [
    ...list(git(project, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', exclude])).map(path => ({ status: '?', path, note: 'untracked' })),
    ...list(git(project, ['ls-files', '-v', '-z', '--', '.', exclude])).filter(entry => /^(?:[a-z]|S) /.test(entry))
      .map(entry => ({ status: 'H', path: entry.slice(2), note: 'hidden by an index flag; shown in full' }))
  ].filter(file => !files.some(known => known.path === file.path));
  // Sparse checkouts flag every file outside the cone skip-worktree; absent files are not changes.
  for (let i = extra.length - 1; i >= 0; i--) {
    if (extra[i].status === 'H' && !(await lstat(resolve(project, extra[i].path)).catch(() => null))) extra.splice(i, 1);
  }
  const sections = git(project, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', '.', exclude])
    .split(/^(?=diff --git )/m).filter(Boolean).map((text, index) => ({ path: files[index]?.path ?? '', text }));
  for (const file of extra) {
    files.push({ status: file.status, path: file.path });
    sections.push({ path: file.path, text: `--- /dev/null\n+++ b/${header(file.path)} (${file.note})\n${await fullContent(project, file.path)}\n` });
  }
  const triggers = new Set();
  for (const file of files) {
    file.categories = categories([file.path]);
    for (const category of file.categories) if (pathTriggers[category]) triggers.add(pathTriggers[category]);
  }
  const added = sections.filter(section => !testPath.test(section.path))
    .map(section => section.text.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')).join('\n');
  for (const [name, pattern] of Object.entries(contentTriggers)) if (pattern.test(added)) triggers.add(name);
  const diff = sections.map(section => section.text).join('\n');
  const truncated = diff.length > diffLimit;
  // Existing tests changed, retyped or removed since the base: refactors must justify each
  // one. A test moved without content changes (rename score 100) is not listed.
  const renamed = list(git(project, ['diff', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', base, '--', '.', exclude]));
  const pureMoves = new Set();
  for (let i = 0; i < renamed.length;) {
    const status = renamed[i++];
    if (status.startsWith('R') || status.startsWith('C')) { if (status === 'R100') pureMoves.add(renamed[i]); i += 2; } else i += 1;
  }
  const modifiedTests = files.filter(file => ['M', 'D', 'T', 'H'].includes(file.status) && testPath.test(file.path) && !pureMoves.has(file.path)).map(file => file.path);
  return { files, securityTriggers: [...triggers].sort(), modifiedTests, diff: truncated ? `${diff.slice(0, diffLimit)}\n… diff truncated at ${diffLimit} bytes; read the files directly.\n` : diff, truncated };
}
