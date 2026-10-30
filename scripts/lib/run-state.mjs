import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fail } from './cli.mjs';
import { git, requireRoot, headCommit } from './git.mjs';

export const runsPath = '.project-os/runs';
export const types = ['app', 'feature', 'change', 'fix', 'refactor'];
export const tiers = ['trivial', 'small', 'standard', 'large'];
export const stages = ['intake', 'spec', 'architecture', 'plan', 'implement', 'verify', 'evaluate', 'release', 'done', 'stopped'];
export const tierGates = { trivial: [], small: [], standard: ['spec', 'plan'], large: ['spec', 'architecture', 'plan'] };
export const gateArtifacts = { spec: 'spec.md', architecture: 'architecture.md', plan: 'plan.md' };
// The evaluation that must PASS on the current artifact before its human gate opens.
export const gateEvalKeys = { spec: 'spec', architecture: 'plan-architecture', plan: 'plan' };
export const runPattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// A short name ("avatar-upload") resolves to the one dated run that ends with it.
async function resolveRunName(project, name) {
  const matches = (await readdir(resolve(project, runsPath))).filter(entry => runPattern.test(entry) && entry.slice(11) === name);
  if (matches.length === 1) return matches[0];
  if (!matches.length) fail('RUN_MISSING', 'The run does not exist.');
  fail('AMBIGUOUS', `Several runs are named ${name}: ${matches.sort().join(', ')}. Use the dated name.`);
}
// Run files live in real directories inside the project; symlinked parents are refused.
export async function runDirectory(project, value, { create = false } = {}) {
  const short = !create && typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !runPattern.test(value);
  if (typeof value !== 'string' || value.length > 80 || !(short || runPattern.test(value))) fail('INVOCATION', '--run must be a run name, either YYYY-MM-DD-name or the name alone (lowercase letters, digits, hyphens).');
  for (const path of ['.project-os', runsPath]) {
    const current = await info(resolve(project, path));
    if (!current && create) await mkdir(resolve(project, path));
    else if (!current) fail('RUN_MISSING', 'No runs exist in this project.');
    else if (!current.isDirectory() || current.isSymbolicLink()) fail('RUN', 'Run parent paths must be real directories, not symlinks or files.');
  }
  const run = short ? await resolveRunName(project, value) : value;
  const directory = resolve(project, runsPath, run);
  const current = await info(directory);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) fail('RUN', 'The run path must be a real directory.');
  if (!current && !create) fail('RUN_MISSING', 'The run does not exist.');
  return directory;
}

function invalid(where, reason) { fail('STATE', `state.json ${where}: ${reason}`); }
function plainObject(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(where, 'expected an object');
}
// Mirrors schemas/state.schema.json; tests check both agree on fixtures.
export function validateState(input) {
  plainObject(input, 'root');
  const fields = ['schemaVersion', 'run', 'type', 'tier', 'stage', 'gates', 'steps', 'evals', 'checkpoints', 'createdAt', 'updatedAt'];
  if (Object.keys(input).some(key => !fields.includes(key) && !['configHash', 'baseHead'].includes(key)) || fields.some(key => !Object.hasOwn(input, key))) invalid('root', 'unknown or missing field');
  if (Object.hasOwn(input, 'configHash') && (typeof input.configHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.configHash))) invalid('configHash', 'expected sha256:<hex>');
  if (Object.hasOwn(input, 'baseHead') && (typeof input.baseHead !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.baseHead))) invalid('baseHead', 'expected a commit SHA');
  if (input.schemaVersion !== 1) invalid('schemaVersion', 'expected integer 1');
  if (typeof input.run !== 'string' || input.run.length > 80 || !runPattern.test(input.run)) invalid('run', 'invalid run name');
  if (!types.includes(input.type)) invalid('type', 'unsupported value');
  if (!tiers.includes(input.tier)) invalid('tier', 'unsupported value');
  if (!stages.includes(input.stage)) invalid('stage', 'unsupported value');
  plainObject(input.gates, 'gates');
  for (const [name, gate] of Object.entries(input.gates)) {
    if (!Object.hasOwn(gateArtifacts, name)) invalid('gates', 'unknown gate');
    plainObject(gate, `gates.${name}`);
    if (Object.keys(gate).some(key => !['status', 'by', 'artifactHash', 'at'].includes(key))) invalid(`gates.${name}`, 'unknown field');
    if (!['pending', 'approved', 'revision_requested'].includes(gate.status)) invalid(`gates.${name}.status`, 'unsupported value');
    if (gate.status === 'approved' && ['by', 'artifactHash', 'at'].some(key => !Object.hasOwn(gate, key))) invalid(`gates.${name}`, 'approval needs by, artifactHash and at');
    if (Object.hasOwn(gate, 'by') && gate.by !== 'human') invalid(`gates.${name}.by`, 'expected human');
    if (Object.hasOwn(gate, 'artifactHash') && !/^sha256:[0-9a-f]{64}$/.test(gate.artifactHash)) invalid(`gates.${name}.artifactHash`, 'expected sha256:<hex>');
    if (Object.hasOwn(gate, 'at') && !timestampPattern.test(gate.at)) invalid(`gates.${name}.at`, 'expected UTC timestamp');
  }
  plainObject(input.steps, 'steps');
  for (const [id, status] of Object.entries(input.steps)) {
    if (!/^S[1-9][0-9]*$/.test(id)) invalid('steps', 'expected S<n> keys');
    if (!['pending', 'in_progress', 'done', 'reverted'].includes(status)) invalid(`steps.${id}`, 'unsupported value');
  }
  plainObject(input.evals, 'evals');
  for (const [key, summary] of Object.entries(input.evals)) {
    if (!/^[a-z]+(?:-[a-z0-9]+)*$/.test(key)) invalid('evals', 'invalid key');
    plainObject(summary, `evals.${key}`);
    if (Object.keys(summary).length !== 3 || !['verdict', 'round', 'subject'].every(field => Object.hasOwn(summary, field))) invalid(`evals.${key}`, 'expected verdict, round and subject');
    if (!['PASS', 'FAIL', 'BLOCKED'].includes(summary.verdict)) invalid(`evals.${key}.verdict`, 'unsupported value');
    if (!Number.isSafeInteger(summary.round) || summary.round < 1 || summary.round > 3) invalid(`evals.${key}.round`, 'expected 1 to 3');
    if (typeof summary.subject !== 'string' || !/^(?:fp|sha256):[0-9a-f]{64}$/.test(summary.subject)) invalid(`evals.${key}.subject`, 'invalid subject');
  }
  if (!Array.isArray(input.checkpoints) || new Set(input.checkpoints).size !== input.checkpoints.length
    || input.checkpoints.some(sha => typeof sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha))) invalid('checkpoints', 'expected unique commit SHAs');
  for (const field of ['createdAt', 'updatedAt']) if (typeof input[field] !== 'string' || !timestampPattern.test(input[field])) invalid(field, 'expected UTC timestamp');
  return input;
}

// Run files are read only as regular files: a symlink could redirect evidence outside the run.
export async function readRunFile(directory, name) {
  const path = resolve(directory, name);
  const current = await info(path);
  if (!current) return null;
  if (!current.isFile()) fail('RUN', `${name} must be a regular file, not a symlink or directory.`);
  return readFile(path, 'utf8');
}
export async function runSubdirectory(directory, name) {
  const path = resolve(directory, name);
  const current = await info(path);
  if (!current) await mkdir(path);
  else if (!current.isDirectory() || current.isSymbolicLink()) fail('RUN', `${name}/ must be a real directory, not a symlink or file.`);
  return path;
}
export async function readState(directory) {
  const source = await readRunFile(directory, 'state.json');
  if (source === null) fail('RUN_MISSING', 'The run has no state.json.');
  let input;
  try { input = JSON.parse(source); } catch { fail('STATE', 'state.json must be valid JSON.'); }
  return validateState(input);
}
export function writeJsonAtomic(path, value) {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
// Temp file, fsync, rename: readers never observe a partial file, and a crash keeps the old or new version.
export async function writeAtomic(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } catch { /* Directory fsync is unsupported on some filesystems. */ }
  finally { await parent.close(); }
}
export async function writeState(directory, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(resolve(directory, 'state.json'), validateState(state));
}
// One state writer at a time. A crash can leave the lock behind; it is reported, never broken silently.
export async function withLock(directory, action) {
  const path = resolve(directory, 'state.lock');
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') fail('LOCKED', 'Another peos-run is updating this run. If none is running, inspect and remove state.lock.');
    throw error;
  }
  try { return await action(); }
  finally { await handle.close(); await rm(path, { force: true }); }
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolvePromise(hash.digest('hex')));
  });
}
// The configured checks in force; recorded checks must use the configuration the run started with.
export async function configHash(project) {
  const path = resolve(project, '.project-os/engineering.config.json');
  const current = await info(path);
  return current?.isFile() ? `sha256:${await sha256File(path)}` : null;
}
export async function artifactHash(directory, gate) {
  const path = resolve(directory, gateArtifacts[gate]);
  const current = await info(path);
  if (!current || !current.isFile()) return null;
  return `sha256:${await sha256File(path)}`;
}

async function contentState(path) {
  const current = await info(path);
  if (!current) return 'deleted';
  if (current.isSymbolicLink()) return `link:${createHash('sha256').update(await readlink(path)).digest('hex')}`;
  // Submodule or nested repository: its contents are not covered, so evidence would silently go stale.
  if (current.isDirectory()) fail('FINGERPRINT', 'A changed submodule or untracked nested repository cannot be fingerprinted; commit, ignore or remove it.');
  return `${current.mode & 0o111 ? 'x' : 'f'}:${await sha256File(path)}`;
}
/**
 * Code-state fingerprint: HEAD plus the working-tree content of every path that
 * differs from HEAD (staged, unstaged, untracked, assume-unchanged, skip-worktree).
 * Gitignored files and run artifacts are excluded, so recording evidence does not
 * change the state it describes.
 */
export async function fingerprint(project) {
  requireRoot(project);
  const head = headCommit(project);
  const list = raw => raw.split('\0').filter(Boolean);
  // Assume-unchanged (lowercase tag) and skip-worktree (S) entries are invisible to diff, so hash them directly.
  const hidden = list(git(project, ['ls-files', '-v', '-z'])).filter(entry => /^(?:[a-z]|S) /.test(entry)).map(entry => entry.slice(2));
  const paths = new Set([
    ...list(git(project, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', 'HEAD', '--'])),
    ...list(git(project, ['ls-files', '--others', '--exclude-standard', '-z'])),
    ...hidden
  ]);
  const hash = createHash('sha256').update(`peos-fingerprint-v1\0${head}\0`);
  let count = 0;
  for (const path of [...paths].filter(path => !path.startsWith(`${runsPath}/`)).sort()) {
    hash.update(`${path}\0${await contentState(resolve(project, path))}\0`);
    count++;
  }
  return { codeState: `fp:${hash.digest('hex')}`, head, changedPaths: count };
}
