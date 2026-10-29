import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fail } from './cli.mjs';

const messages = {
  GIT: 'Git operation failed (Git missing, unreadable repository, timeout, or output limit).',
  NOT_GIT: 'The target must be a Git working-tree root.',
  NO_HEAD: 'Repositories without an initial commit are unsupported.',
  REFERENCE: 'Reference cannot be resolved to a commit; no fallback or fetch was attempted.',
  MERGE_BASE: 'No merge base is available (unrelated or incomplete history); no fallback or fetch was attempted.'
};
export function git(project, args, code = 'GIT') {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', project, ...args], {
    encoding: 'utf8', env, timeout: 10000, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) fail(code, messages[code]);
  return result.stdout;
}
export function requireRoot(project) {
  const root = git(project, ['rev-parse', '--show-toplevel'], 'NOT_GIT').replace(/\n$/, '');
  if (realpathSync(root) !== project) fail('NOT_GIT', 'Use the Git working-tree root as --project.');
}
export function headCommit(project) {
  return git(project, ['rev-parse', '--verify', 'HEAD^{commit}'], 'NO_HEAD').trim();
}
