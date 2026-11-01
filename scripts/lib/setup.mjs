import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fail, ToolkitError } from './cli.mjs';
import { git, headCommit } from './git.mjs';
import { loadConfig, validateConfig } from './config.mjs';
import { readState, runDirectory, runsPath, writeJsonAtomic } from './run-state.mjs';

// Project setup: the configuration is derived from the project's own manifests, never
// invented by a model, so the commands peos-run executes are the project's declared ones.
export const configPath = '.project-os/engineering.config.json';
export const profilePath = '.project-os/project-profile.md';
export const instructionFiles = ['AGENTS.md', 'CLAUDE.md'];
// A profile is stale after this many changed files, or any manifest change, since it was written.
const staleFiles = 25;
const manifests = /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|pyproject\.toml|go\.mod|Cargo\.toml|Package\.swift|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|tsconfig\.json)$/;

async function exists(project, path) {
  const current = await lstat(resolve(project, path)).catch(() => null);
  return Boolean(current?.isFile());
}
async function text(project, path) {
  return await exists(project, path) ? readFile(resolve(project, path), 'utf8') : null;
}
const check = (id, executable, args, phases, kind, timeoutMs = 600000) => ({ id, executable, args, phases, required: true, timeoutMs, kind });

async function nodeChecks(project) {
  const source = await text(project, 'package.json');
  if (source === null) return [];
  let manifest;
  try { manifest = JSON.parse(source); } catch { fail('SETUP', 'package.json is not valid JSON.'); }
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null;
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
  let manager = declared && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared : null;
  for (const [lock, name] of locks) if (!manager && await exists(project, lock)) manager = name;
  manager ??= 'npm';
  const usable = name => typeof scripts[name] === 'string' && !/no test specified/.test(scripts[name]);
  const first = names => names.find(usable);
  const checks = [];
  const add = (id, names, phases, kind, timeoutMs) => {
    const name = first(names);
    if (name) checks.push(check(id, manager, ['run', name], phases, kind, timeoutMs));
  };
  add('tests', ['test', 'test:unit'], ['task', 'release'], 'test');
  add('typecheck', ['typecheck', 'type-check', 'check-types', 'tsc'], ['task', 'release'], 'typecheck', 300000);
  add('lint', ['lint'], ['task', 'release'], 'lint', 300000);
  add('format', ['check-format', 'format:check', 'format-check'], ['task', 'release'], 'other', 300000);
  add('docs', ['docs:check', 'check:docs'], ['task', 'release'], 'other', 300000);
  add('build', ['build'], ['release'], 'build');
  return checks;
}
async function otherChecks(project) {
  const checks = [];
  // A pyproject.toml or setup.cfg alone may only configure linters; pytest needs its own sign.
  const pytest = await exists(project, 'pytest.ini') || await exists(project, 'conftest.py')
    || /\[tool\.pytest/.test(await text(project, 'pyproject.toml') ?? '') || /\[tool:pytest\]/.test(await text(project, 'setup.cfg') ?? '');
  if (pytest) {
    const runner = await exists(project, 'uv.lock') ? ['uv', ['run', 'pytest']] : await exists(project, 'poetry.lock') ? ['poetry', ['run', 'pytest']] : ['python3', ['-m', 'pytest']];
    checks.push(check('tests', runner[0], runner[1], ['task', 'release'], 'test'));
  }
  if (await exists(project, 'go.mod')) checks.push(check('tests', 'go', ['test', './...'], ['task', 'release'], 'test'), check('vet', 'go', ['vet', './...'], ['task', 'release'], 'lint', 300000), check('build', 'go', ['build', './...'], ['release'], 'build'));
  if (await exists(project, 'Cargo.toml')) checks.push(check('tests', 'cargo', ['test'], ['task', 'release'], 'test'), check('build', 'cargo', ['build'], ['release'], 'build'));
  if (await exists(project, 'Package.swift')) checks.push(check('tests', 'swift', ['test'], ['task', 'release'], 'test'), check('build', 'swift', ['build'], ['release'], 'build'));
  if (await exists(project, 'gradlew')) checks.push(check('tests', './gradlew', ['test'], ['task', 'release'], 'test'), check('build', './gradlew', ['build'], ['release'], 'build'));
  return checks;
}
// Several ecosystems in one repository: later duplicates get a prefix from their tool.
export async function detectChecks(project) {
  const ids = new Set();
  return [...await nodeChecks(project), ...await otherChecks(project)].map(entry => {
    const id = ids.has(entry.id) ? `${basename(entry.executable)}-${entry.id}` : entry.id;
    ids.add(id);
    return { ...entry, id };
  }).filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
}
async function projectName(project) {
  try { const name = JSON.parse(await text(project, 'package.json') ?? '{}').name; if (typeof name === 'string' && name.trim()) return name; } catch { /* fall back */ }
  return basename(project);
}

// Profile freshness from its marker line: <!-- peos-profile head=<commit> -->.
async function profileStatus(project) {
  const source = await text(project, profilePath);
  if (source === null) return { status: 'missing' };
  const head = /^\s*(?:```\w*\s*)?<!-- peos-profile head=([0-9a-f]{40}) -->/.exec(source)?.[1];
  if (!head) return { status: 'stale', reason: 'no recorded commit' };
  let changed;
  try { changed = git(project, ['diff', '--name-only', head, 'HEAD']).split('\n').filter(Boolean); }
  catch (error) { if (error instanceof ToolkitError) return { status: 'stale', reason: 'recorded commit is not in this history' }; throw error; }
  if (changed.some(path => manifests.test(path))) return { status: 'stale', reason: 'a manifest changed', changedFiles: changed.length };
  if (changed.length >= staleFiles) return { status: 'stale', reason: `${changed.length} files changed`, changedFiles: changed.length };
  return { status: 'fresh', changedFiles: changed.length };
}

// Static task checks the manifests declare but an existing configuration lacks. Test
// commands are left out: a configuration may already run its tests under another name.
function missingChecks(config, detected) {
  const script = entry => entry.args.at(-1);
  return detected.filter(entry => entry.phases.includes('task') && entry.kind !== 'test'
    && !config.checks.some(existing => existing.id === entry.id || (entry.kind !== 'other' && existing.kind === entry.kind) || (existing.executable === entry.executable && script(existing) === script(entry))));
}
// Configured checks that AGENTS.md requires for code changes but only the release phase runs.
// The instructions select among configured checks; they never add a command.
async function checksToPromote(project, config) {
  const lines = (await text(project, 'AGENTS.md') ?? '').split('\n').filter(line => /\bcode changes?\b|kod değişiklik/i.test(line));
  const required = new Set(lines.flatMap(line => [...line.matchAll(/`(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:-]+)`/g)].map(match => match[1])));
  return config.checks.filter(entry => !entry.phases.includes('task') && required.has(entry.args.at(-1)));
}
// A run past implementation start is bound to the configuration, so checks are added
// only while no run is before its release stage.
async function runInProgress(project) {
  const names = await readdir(resolve(project, runsPath)).catch(() => []);
  for (const name of names.filter(entry => !entry.startsWith('.'))) {
    const state = await runDirectory(project, name).then(readState).catch(() => null);
    if (state && !['release', 'done', 'stopped'].includes(state.stage)) return true;
  }
  return false;
}
// Claude Code loads CLAUDE.md, not AGENTS.md; the import makes the project's rules load.
async function linkInstructions(project) {
  try { await writeFile(resolve(project, 'CLAUDE.md'), '@AGENTS.md\n', { flag: 'wx' }); return 'created'; }
  catch (error) { if (error.code === 'EEXIST') return 'present'; throw error; }
}

export async function setupProject(project) {
  const head = headCommit(project);
  let config = 'existing';
  if (await text(project, configPath) === null) {
    const checks = await detectChecks(project);
    if (!checks.length) fail('SETUP', `No test command could be detected from the root manifests (workspace packages and nested projects are not searched). Add a root test script or write ${configPath} by hand (see the toolkit's templates/engineering.config.json).`);
    const created = validateConfig({
      schemaVersion: 1, projectName: await projectName(project), outputLanguage: 'tr',
      // AGENTS.md is listed even when missing: setup is followed by creating it.
      references: { instructions: ['AGENTS.md', ...(await exists(project, 'CLAUDE.md') ? ['CLAUDE.md'] : [])], architecture: [], design: [] },
      checks,
      manualChecks: [{ id: 'release-environment', description: 'Confirm the target environment and required migration, visual, and performance evidence against project policy; record justified non-applicability.', phases: ['release'], required: true }]
    });
    const directory = await lstat(resolve(project, '.project-os')).catch(() => null);
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) fail('SETUP', '.project-os must be a real directory.');
    await mkdir(resolve(project, '.project-os'), { recursive: true });
    await writeJsonAtomic(resolve(project, configPath), created);
    config = 'created';
  }
  const current = await loadConfig(project);
  const missing = config === 'created' ? [] : missingChecks(current, await detectChecks(project));
  const promoted = await checksToPromote(project, current);
  const changes = [...missing, ...promoted];
  const label = entry => `${entry.id}: ${[entry.executable, ...entry.args].join(' ')}`;
  const add = changes.length > 0 && !await runInProgress(project);
  if (add) {
    const checks = current.checks.map(entry => promoted.includes(entry) ? { ...entry, phases: ['task', ...entry.phases] } : entry);
    await writeJsonAtomic(resolve(project, configPath), validateConfig({ ...JSON.parse(await text(project, configPath)), checks: [...checks, ...missing] }));
    if (config === 'existing') config = 'updated';
  }
  const instructions = Object.fromEntries(await Promise.all(instructionFiles.map(async path => [path, await exists(project, path) ? 'present' : 'missing'])));
  if (instructions['AGENTS.md'] === 'present' && instructions['CLAUDE.md'] === 'missing') instructions['CLAUDE.md'] = await linkInstructions(project);
  return { config, configPath: resolve(project, configPath), addedChecks: add ? changes.map(label) : [], suggestedChecks: add ? [] : changes.map(label), checks: (await loadConfig(project)).checks.map(entry => `${entry.id}: ${[entry.executable, ...entry.args].join(' ')}`),
    instructions, profile: { path: resolve(project, profilePath), head, ...await profileStatus(project) } };
}
