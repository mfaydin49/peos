import { randomBytes } from 'node:crypto';
import { lstat, readFile, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fail } from './cli.mjs';
import { runsPath, runDirectory, writeJsonAtomic } from './run-state.mjs';

// A grant is the trace of a human command (/peos:approve, /peos:revise, /peos:retry)
// written by the approval-capture hook. Gate decisions consume one; it lasts minutes.
export const grantFile = '.grant.json';
export const grantActions = ['approve', 'revise', 'reset-eval'];
const lifetimeMs = 15 * 60 * 1000;

export function grantPath(project) {
  return resolve(project, runsPath, grantFile);
}
export async function writeGrant(project, { action, target, run = null, source }) {
  if (!grantActions.includes(action)) fail('INVOCATION', `Grant action must be one of: ${grantActions.join(', ')}.`);
  if (typeof target !== 'string' || !/^[a-z]+(?:-[a-z0-9]+)*$/.test(target)) fail('INVOCATION', 'Grant target must be a gate or evaluation key.');
  const runs = await lstat(resolve(project, runsPath)).catch(() => null);
  if (!runs || !runs.isDirectory() || runs.isSymbolicLink()) fail('RUN_MISSING', 'No runs exist in this project.');
  const grant = { schemaVersion: 1, action, target, run, source, at: new Date().toISOString() };
  await writeJsonAtomic(grantPath(project), grant);
  return grant;
}
// Inside Claude Code only grants written by the approval-capture hook count.
export const insideClaudeCode = () => Boolean(process.env.CLAUDECODE);
// Consumed on every attempt, successful or not: a refused approval must not be reusable
// later for an artifact the human has not seen. Claiming by rename lets one caller win.
export async function consumeGrant(project, action, target, run) {
  const path = grantPath(project);
  const claimed = `${path}.claimed-${process.pid}-${randomBytes(4).toString('hex')}`;
  let grant = null;
  try {
    await rename(path, claimed);
    const current = await lstat(claimed);
    if (current.isFile()) grant = JSON.parse(await readFile(claimed, 'utf8'));
  } catch { grant = null; }
  finally { await rm(claimed, { force: true }); }
  const command = { approve: '/peos:approve', revise: '/peos:revise', 'reset-eval': '/peos:retry' }[action];
  const refuse = reason => fail('GRANT', `${reason} This decision belongs to the user: it needs "${command} ${target}" typed by the user just before.`);
  if (!grant) refuse('No pending user decision was found.');
  if (grant.action !== action || grant.target !== target) refuse(`The pending user decision is "${grant.action} ${grant.target}", not "${action} ${target}".`);
  const age = Date.now() - Date.parse(grant.at);
  if (!(age >= 0 && age <= lifetimeMs)) refuse('The pending user decision has expired.');
  if (insideClaudeCode() && grant.source !== 'user-prompt') refuse('Inside Claude Code only a decision typed by the user counts.');
  if (grant.run !== null && grant.run !== undefined) {
    const named = basename(await runDirectory(project, grant.run));
    if (named !== run) refuse(`The user's decision names run ${named}, not ${run}.`);
  }
  return grant;
}
