import { lstat, readFile, readlink, mkdir, symlink, appendFile, realpath, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, relative } from 'node:path';
import { main, parseArgs, projectDirectory, fail, requirePlatform } from './lib/cli.mjs';
import { loadConfig } from './lib/config.mjs';

const toolkit = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const names = ['peos-task-planning', 'peos-implementation', 'peos-code-review', 'peos-release-check'];
async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
await main(async () => {
  const options = parseArgs(process.argv.slice(2), ['project']);
  requirePlatform();
  const project = await projectDirectory(options.project);
  if (project === toolkit) fail('SETUP', 'Choose a consuming project, not the toolkit itself.');
  for (const path of ['.project-os', '.agents', '.agents/skills']) {
    const existing = await info(resolve(project, path));
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) fail('SETUP', 'Integration parent paths must be real directories, not symlinks or files.');
  }
  await loadConfig(project); // Setup never invents or overwrites project check commands.
  if (await info(resolve(project, 'AGENTS.override.md'))) fail('SETUP', 'AGENTS.override.md may shadow AGENTS.md. Integrate the template manually into the active instruction file.');
  const agentsPath = resolve(project, 'AGENTS.md');
  const existing = await info(agentsPath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('SETUP', 'AGENTS.md must be a regular file; integrate manually otherwise.');
  const previous = existing ? await readFile(agentsPath, 'utf8') : '';
  const section = await readFile(resolve(toolkit, 'templates/AGENTS.md'), 'utf8');
  const hasSection = previous.includes(section);
  if (!hasSection && /<!-- personal-engineering-os:(start|end) -->/.test(previous)) fail('SETUP', 'An edited or incomplete integration section exists; review it manually.');
  const links = [
    [resolve(project, '.project-os/toolkit'), toolkit],
    ...names.map(name => [resolve(project, '.agents/skills', name), resolve(toolkit, 'skills', name)])
  ];
  const missing = [];
  for (const [path, target] of links) {
    const current = await info(path);
    if (!current) missing.push([path, target]);
    else if (!current.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== target) fail('SETUP', 'An integration path is already occupied; nothing has been overwritten.');
  }
  const created = [];
  try {
    for (const [path, target] of missing) {
      await mkdir(dirname(path), { recursive: true });
      await symlink(relative(dirname(path), target), path, 'dir');
      created.push(path);
    }
    if (!hasSection) await appendFile(agentsPath, `${previous ? '\n\n' : ''}${section}`, { flag: existing ? 'a' : 'wx' });
  } catch {
    for (const path of created.reverse()) await unlink(path);
    fail('SETUP', 'Setup could not finish; newly created links were rolled back. Inspect AGENTS.md and empty integration directories before retrying.');
  }
  return { report: { status: 'PASS', project, skills: names, linksCreated: missing.length, instructionsAppended: !hasSection,
    notice: 'Setup completed. Start a fresh Codex session in the project and verify discovery; setup alone is not a runtime invocation test.' }};
}, report => `${report.status}: Codex integration prepared for ${JSON.stringify(report.project)}.\n${report.notice}`);
