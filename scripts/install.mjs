// One-time project install: prepares the project once and connects Claude Code (the plugin,
// for this project only), Codex and Copilot (the instruction workflow through AGENTS.md and
// .agents/skills). Safe to repeat. Nothing is committed.
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, main, parseArgs, projectDirectory, requirePlatform } from './lib/cli.mjs';
import { git } from './lib/git.mjs';

const toolkit = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const links = ['.project-os/toolkit', '.agents/skills/peos-task-planning', '.agents/skills/peos-implementation', '.agents/skills/peos-code-review', '.agents/skills/peos-release-check'];

function script(name, args) {
  const result = spawnSync(process.execPath, [resolve(toolkit, 'scripts', name), ...args, '--json'], { encoding: 'utf8' });
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail('INSTALL', `${name} returned no report.`); }
  if (report.status === 'ERROR') fail(report.error.code, report.error.message);
  return report;
}
// The links point into this machine's toolkit, so they stay out of the project's commits.
async function excludeLinks(project) {
  const path = resolve(project, git(project, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const current = await readFile(path, 'utf8').catch(() => '');
  const missing = links.filter(link => !current.split('\n').includes(link));
  if (!missing.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}
// Local scope: enabled for this user in this project, read from this toolkit directory.
function installClaudePlugin(project) {
  for (const args of [['marketplace', 'add', toolkit, '--scope', 'local'], ['install', 'peos@peos-local', '--scope', 'local']]) {
    const result = spawnSync('claude', ['plugin', ...args], { cwd: project, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') return 'skipped: claude is not installed';
    if (result.status !== 0) fail('INSTALL', `claude plugin ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
  }
  return 'installed';
}

await main(async () => {
  const options = parseArgs(process.argv.slice(2), ['project']);
  requirePlatform();
  const project = await projectDirectory(options.project);
  if (project === toolkit) fail('INSTALL', 'Choose a consuming project, not the toolkit itself.');
  const run = ['--project', project];
  // An empty project has no checks until an app run's walking skeleton declares them; the
  // instruction workflow for Codex and Copilot needs them, so it is connected on a later install.
  const deferred = script('peos-run.mjs', ['setup', ...run]).config === 'deferred';
  if (!deferred) {
    script('setup-codex.mjs', run);
    await excludeLinks(project);
  }
  // Run again: setup-codex may have just created AGENTS.md, which CLAUDE.md imports.
  const { checks, instructions } = script('peos-run.mjs', ['setup', ...run]);
  return { report: { status: 'PASS', project, checks, instructions, claude: installClaudePlugin(project),
    instructionWorkflow: deferred ? 'skipped: empty project; install again after the app\'s first milestone' : 'connected' } };
}, report => [`PEOS installed in ${report.project}.`, `Checks: ${report.checks.length ? report.checks.join('; ') : 'none yet (empty project: start an app with /peos:start; its first milestone declares them)'}`, `Claude Code: ${report.claude}`,
  `Codex and Copilot: ${report.instructionWorkflow === 'connected' ? 'AGENTS.md and .agents/skills connected' : report.instructionWorkflow}`,
  'Review the checks, then open a new session in the project. Nothing was committed.'].join('\n'));
