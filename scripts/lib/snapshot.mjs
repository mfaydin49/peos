import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolkitError } from './cli.mjs';
import { git } from './git.mjs';

// Code snapshots for delta evaluation (design eval-economy.md): the working tree as Git
// sees it, without run files, written as a tree object through a temporary index. The
// working tree and the real index are untouched; the tree is an unreferenced object
// that git gc may prune later, which only means the next evaluation is a full one.
const runFiles = ':(exclude).project-os/runs';

export async function snapshotTree(project) {
  const scratch = await mkdtemp(join(tmpdir(), 'peos-index-'));
  // The temporary index has no cached file stats, so add re-hashes every file: allow longer.
  const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') }, timeout: 60000 };
  const quiet = ['-c', 'core.hooksPath=/dev/null'];
  try {
    git(project, [...quiet, 'read-tree', 'HEAD'], 'GIT', options);
    git(project, [...quiet, 'add', '-A', '--', '.', runFiles], 'GIT', options);
    return git(project, [...quiet, 'write-tree'], 'GIT', options).trim();
  } catch (error) {
    if (error instanceof ToolkitError) return null;
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export function treeExists(project, tree) {
  if (typeof tree !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) return false;
  try { git(project, ['cat-file', '-e', `${tree}^{tree}`]); return true; }
  catch (error) { if (error instanceof ToolkitError) return false; throw error; }
}
