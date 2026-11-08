// What eval-ui looks at (docs/design/eval-ui.md §5): screenshots a project's ui-capture
// check wrote into <run>/ui/, or a local preview server peos-run started for the run.
import { spawn, spawnSync } from 'node:child_process';
import { lstat, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail } from './cli.mjs';
import { readRunFile, writeJsonAtomic } from './run-state.mjs';

const manifestLimit = 1024 * 1024;
const shotLimit = 60;
const imageLimit = 10 * 1024 * 1024;
const imageName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g)$/i;
const impacts = ['minor', 'moderate', 'serious', 'critical'];

function label(value, max) {
  return typeof value === 'string' && /\S/.test(value) && value.length <= max;
}
// The manifest a ui-capture check wrote: every shot an image file directly inside the UI
// directory, named with its screen and state. Returns what eval-ui is given, or why not.
export async function readManifest(directory) {
  const path = resolve(directory, 'manifest.json');
  const current = await lstat(path).catch(() => null);
  if (!current) return { status: 'missing', reason: `The ui-capture check wrote no ${path}.` };
  if (!current.isFile()) return { status: 'invalid', reason: 'manifest.json must be a regular file.' };
  if (current.size > manifestLimit) return { status: 'invalid', reason: 'manifest.json exceeds 1 MiB.' };
  let manifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch { return { status: 'invalid', reason: 'manifest.json must be valid JSON.' }; }
  const invalid = reason => ({ status: 'invalid', reason: `manifest.json: ${reason}` });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid('expected an object');
  if (Object.keys(manifest).some(key => !['shots', 'a11y'].includes(key))) return invalid('unknown field');
  const { shots, a11y = [] } = manifest;
  if (!Array.isArray(shots) || !shots.length || shots.length > shotLimit) return invalid(`expected one to ${shotLimit} shots`);
  for (const [index, shot] of shots.entries()) {
    const where = `shots[${index}]`;
    if (!shot || typeof shot !== 'object' || Object.keys(shot).some(key => !['file', 'screen', 'state', 'viewport', 'scheme'].includes(key))) return invalid(`${where}: expected file, screen, state and optional viewport and scheme`);
    if (typeof shot.file !== 'string' || !imageName.test(shot.file)) return invalid(`${where}.file: expected a PNG or JPEG file name directly inside the UI directory`);
    if (!label(shot.screen, 120) || !label(shot.state, 120)) return invalid(`${where}: screen and state must be non-blank text up to 120 characters`);
    for (const field of ['viewport', 'scheme']) if (Object.hasOwn(shot, field) && !label(shot[field], 40)) return invalid(`${where}.${field}: expected text up to 40 characters`);
    const image = await lstat(resolve(directory, shot.file)).catch(() => null);
    if (!image?.isFile()) return invalid(`${where}.file: ${shot.file} is missing or not a regular file`);
    if (image.size > imageLimit) return invalid(`${where}.file: ${shot.file} exceeds 10 MiB`);
  }
  if (!Array.isArray(a11y) || a11y.length > 200) return invalid('a11y: expected an array of at most 200 entries');
  for (const [index, entry] of a11y.entries()) {
    const where = `a11y[${index}]`;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['screen', 'rule', 'impact', 'target', 'help'].includes(key))) return invalid(`${where}: expected screen, rule, impact and optional target and help`);
    if (!label(entry.screen, 120) || !label(entry.rule, 120) || !impacts.includes(entry.impact)) return invalid(`${where}: screen, rule and an impact (${impacts.join(', ')}) are required`);
    for (const field of ['target', 'help']) if (Object.hasOwn(entry, field) && !label(entry[field], 500)) return invalid(`${where}.${field}: expected text up to 500 characters`);
  }
  return { status: 'captured', directory, manifest: path, shots: shots.length,
    screens: [...new Set(shots.map(shot => shot.screen))],
    a11y: { serious: a11y.filter(entry => entry.impact === 'serious').length, critical: a11y.filter(entry => entry.impact === 'critical').length } };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function answers(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'manual' }); return true; } catch { return false; }
}
async function readPreview(directory) {
  try { return JSON.parse(await readRunFile(directory, 'preview.json') ?? 'null'); } catch { return null; }
}
const exists = target => { try { process.kill(target, 0); return true; } catch { return false; } };
// When a process started, as ps prints it; identifies a pid across reuse.
function started(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
// The preview's process group still exists and is the one the run started. The system
// does not give a new process the ID of a group that still exists, so a group whose
// leader exited is still ours; a living leader must have the recorded start time.
function ours(preview) {
  if (!preview || !Number.isSafeInteger(preview.pid) || preview.pid <= 1 || !exists(-preview.pid)) return false;
  return !exists(preview.pid) || started(preview.pid) === preview.leaderStart;
}
// The run's preview, when the server it started is still running.
export async function runningPreview(directory) {
  const preview = await readPreview(directory);
  return ours(preview) ? preview : null;
}
function killGroup(pid, signal) { try { process.kill(-pid, signal); } catch { /* already gone */ } }
// Starts the configured preview in its own process group and waits until it answers. A
// server the run did not start (the port is taken) is not used: it may be anything. A
// command that starts the server in the background and exits is fine while its group lives.
export async function startPreview(project, directory, preview) {
  const running = await runningPreview(directory);
  if (running && running.url === preview.url) return { ...running, reused: true };
  await stopPreview(directory);
  const ready = `${preview.url}${preview.readyPath}`;
  if (await answers(ready)) fail('PREVIEW', `${preview.url} already answers, but this run did not start it; stop that server or change preview.url.`);
  let failure = null, exit = null;
  const child = spawn(preview.executable, preview.args, { cwd: project, shell: false, detached: true, stdio: 'ignore' });
  child.on('error', error => { failure = `could not start ${preview.executable} (${error.code || 'unknown'})`; });
  child.on('exit', (code, signal) => { exit = signal ? `stopped by ${signal}` : `exited with code ${code}`; });
  child.unref();
  const leaderStart = child.pid ? started(child.pid) : null;
  const deadline = Date.now() + preview.timeoutMs;
  while (!failure && Date.now() < deadline && !(exit && !exists(-child.pid))) {
    if (await answers(ready)) {
      const record = { pid: child.pid, leaderStart, url: preview.url, readyPath: preview.readyPath, startedAt: new Date().toISOString() };
      await writeJsonAtomic(resolve(directory, 'preview.json'), record);
      return { ...record, reused: false };
    }
    await sleep(250);
  }
  if (child.pid) killGroup(child.pid, 'SIGKILL');
  fail('PREVIEW', `The preview did not answer at ${ready}: ${failure ?? exit ?? `no answer within ${preview.timeoutMs} ms`}.`);
}
// Stops the run's preview server and its process group; a recorded preview that is no
// longer the run's own is only forgotten, never signalled.
export async function stopPreview(directory) {
  const preview = await readPreview(directory);
  let stopped = false;
  if (ours(preview)) {
    killGroup(preview.pid, 'SIGTERM');
    for (let waited = 0; waited < 2000 && exists(-preview.pid); waited += 100) await sleep(100);
    if (exists(-preview.pid)) killGroup(preview.pid, 'SIGKILL');
    stopped = true;
  }
  await rm(resolve(directory, 'preview.json'), { force: true });
  return { stopped };
}
