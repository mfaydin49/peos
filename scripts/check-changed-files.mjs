import { main, parseArgs, projectDirectory, fail } from './lib/cli.mjs';
import { git, requireRoot, headCommit } from './lib/git.mjs';
import { categories } from './lib/changes.mjs';

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
  requireRoot(project);
  const head = headCommit(project);
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
