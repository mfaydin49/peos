import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { main, parseArgs, projectDirectory, fail } from './lib/cli.mjs';

function git(project, args, code = 'GIT') {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', project, ...args], {
    encoding: 'utf8', env, timeout: 10000, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) fail(code, {
    GIT: 'Git operation failed (Git missing, unreadable repository, timeout, or output limit).',
    NOT_GIT: 'The target must be a Git working-tree root.',
    NO_HEAD: 'Repositories without an initial commit are unsupported.',
    REFERENCE: 'Reference cannot be resolved to a commit; no fallback or fetch was attempted.',
    MERGE_BASE: 'No merge base is available (unrelated or incomplete history); no fallback or fetch was attempted.'
  }[code]);
  return result.stdout;
}
function categories(paths) {
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
function parseDiff(raw, layer) {
  const tokens = raw.split('\0');
  tokens.pop();
  const entries = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const first = tokens[i++];
    const rename = status.startsWith('R') || status.startsWith('C');
    const destination = rename ? tokens[i++] : first;
    if (!status || first === undefined || destination === undefined) fail('GIT_OUTPUT', 'Unexpected structured Git output.');
    entries.push({ layer, status, path: destination, ...(rename ? { sourcePath: first } : {}), categories: categories(rename ? [first, destination] : [destination]) });
  }
  return entries;
}
const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--name-status', '-z', '--find-renames'];
function localChanges(project) {
  const staged = parseDiff(git(project, [...diffArgs, '--cached', 'HEAD', '--']), 'staged');
  const unstaged = parseDiff(git(project, [...diffArgs, '--']), 'unstaged');
  const untracked = git(project, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    .map(path => ({ layer: 'untracked', status: '?', path, categories: categories([path]) }));
  return [...staged, ...unstaged, ...untracked];
}
await main(async () => {
  const options = parseArgs(process.argv.slice(2), ['project', 'mode', 'reference']);
  const project = await projectDirectory(options.project);
  if (!['working-tree', 'reference'].includes(options.mode)) fail('INVOCATION', '--mode must be working-tree or reference.');
  if ((options.mode === 'reference') !== (options.reference !== undefined)) fail('INVOCATION', '--reference is required only with --mode reference.');
  const root = git(project, ['rev-parse', '--show-toplevel'], 'NOT_GIT').replace(/\n$/, '');
  if (realpathSync(root) !== project) fail('NOT_GIT', 'Use the Git working-tree root as --project.');
  const head = git(project, ['rev-parse', '--verify', 'HEAD^{commit}'], 'NO_HEAD').trim();
  const local = localChanges(project);
  let changes = local, referenceCommit = null, mergeBase = null;
  if (options.mode === 'reference') {
    referenceCommit = git(project, ['rev-parse', '--verify', '--end-of-options', `${options.reference}^{commit}`], 'REFERENCE').trim();
    const bases = git(project, ['merge-base', '--all', referenceCommit, head], 'MERGE_BASE').trim().split('\n');
    if (bases.length !== 1) fail('MERGE_BASE', 'Multiple merge bases are ambiguous; this version does not choose one silently.');
    mergeBase = bases[0];
    changes = parseDiff(git(project, [...diffArgs, mergeBase, head, '--']), 'branch');
  }
  return { report: { reportVersion: 1, kind: 'changed-files', status: 'PASS', project, mode: options.mode,
    head, reference: options.reference ?? null, referenceCommit, mergeBase, changes,
    localChanges: { present: local.length > 0, excluded: options.mode === 'reference', count: local.length,
      ...(options.mode === 'reference' ? { changes: local } : {}) },
    notice: 'Filename categories are review hints, not secret scanning, security review, or migration safety evidence.'
  }};
}, report => [
  `Changes: ${report.mode} (${JSON.stringify(report.project)})`,
  ...report.changes.map(change => `${change.layer} ${change.status} ${change.sourcePath === undefined ? '' : `${JSON.stringify(change.sourcePath)} -> `}${JSON.stringify(change.path)}${change.categories.length ? ` [${change.categories.join(', ')}]` : ''}`),
  report.mode === 'reference' ? `Additional local changes: ${report.localChanges.count} (excluded from branch comparison).` : `Change entries: ${report.changes.length}.`,
  report.notice
].join('\n'));
