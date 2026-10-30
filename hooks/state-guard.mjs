// PreToolUse: keep run state, evidence and user decisions out of the model's reach.
// - Under .project-os/runs/ the model may write only the run's Markdown artifacts and
//   pending-eval.json; everything else there belongs to peos-run.
// - Shell commands that touch .project-os (by text or working directory) are allowed
//   only as a plain call of this plugin's own peos-run, and never its `grant` action.
// - PEOS agents never write files or run commands, except the implementer, which may
//   change project code but not .project-os or run peos-run.
// Shell inspection is a heuristic, not a sandbox: indirection (a script that builds the
// path itself) can evade it, which is why decisions also need a user-created grant.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInput, projectRoot, emit } from './common.mjs';

const peosRun = fileURLToPath(new URL('../scripts/peos-run.mjs', import.meta.url));
const writableArtifacts = ['task.md', 'idea.md', 'spec.md', 'architecture.md', 'plan.md', 'summary.md', 'pending-eval.json'];
const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const peosAgents = /^peos:(?:eval-[a-z-]+|spec-writer|planner|investigator|profiler)$/;
// Names only PEOS run state uses, matched in any directory and case. A project with its
// own state.json or checks.json sees such shell commands refused (the Read/Write tools work).
const protectedFile = /state\.json|checks\.json|state\.lock|\.grant\.json|\.stop-block|runs\/\S*evals/i;

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
// Canonical absolute path: the deepest existing ancestor is resolved through symlinks and
// letter case, so aliases (/tmp → /private/tmp, .Project-OS → .project-os) compare equal.
async function canonical(path) {
  let rest = '';
  for (let current = path; ; current = dirname(current)) {
    try { return resolve(await realpath(current), rest); }
    catch { if (dirname(current) === current) return path; rest = rest ? `${basename(current)}${sep}${rest}` : basename(current); }
  }
}
function within(root, path) {
  const inside = relative(root, path);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)) ? (inside ? inside.split(sep) : []) : null;
}
async function writeAllowed(project, path) {
  const parts = within(resolve(project, '.project-os/runs'), path);
  if (parts === null) return true;
  if (parts.length !== 2 || parts[0].startsWith('.') || !writableArtifacts.includes(parts[1].toLowerCase())) return false;
  const current = await lstat(path).catch(() => null);
  return !current?.isSymbolicLink();
}
// Text that a shell would execute or expand: anything outside single quotes, since
// double quotes still run $(…), backticks and variable expansion.
function expandable(command) {
  return command.replace(/'[^']*'/g, "''");
}
// A plain call: `node <this plugin's peos-run.mjs> <action> …` with nothing to expand
// and no shell operators.
async function plainPeosRun(command) {
  if (/[`$\\]/.test(expandable(command))) return null;
  if (/[;&|<>(){}*?[\]\n]/.test(expandable(command).replace(/"[^"]*"/g, '""'))) return null;
  const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+([a-z][a-z-]*)(?:\s|$)/.exec(command);
  if (!match) return null;
  const script = await realpath(match[1] ?? match[2] ?? match[3]).catch(() => null);
  return script === await realpath(peosRun) ? match[4] : null;
}

// Committing run artifacts: `git add|diff|log|status|show` with plain arguments only.
function plainGitReadOrAdd(command) {
  if (/[`$\\]/.test(expandable(command))) return false;
  if (/[;&|<>(){}*?[\]\n]/.test(expandable(command).replace(/"[^"]*"/g, '""'))) return false;
  if (protectedFile.test(command)) return false;
  return /^\s*git\s+(?:add|diff|log|status|show)(?:\s|$)/.test(command);
}

// The implementer may read Git, never change it: every git invocation, whatever its global
// options (-C dir, -c key=value, --no-pager), must use a read-only subcommand.
function implementerGit(flat) {
  const readOnly = ['diff', 'status', 'log', 'show', 'ls-files', 'blame', 'grep'];
  return [...flat.matchAll(/\bgit((?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+([a-z][\w-]*)/g)].some(([, , sub]) => !readOnly.includes(sub))
    || /\bgit\s*$/.test(flat);
}

const { raw, input } = await readInput();
if (!input) {
  // Fail closed only when the unreadable call plainly targets PEOS state.
  if (/\.project-os|peos-run|\.grant\.json|state\.json/i.test(raw)) deny('PEOS state guard could not read this tool call.');
} else {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  const project = await projectRoot(input);
  const implementer = input.agent_type === 'peos:implementer';
  if (typeof input.agent_type === 'string' && peosAgents.test(input.agent_type) && [...writeTools, 'Bash'].includes(tool)) {
    deny('PEOS agents return their result to the orchestrator; they do not write files or run commands.');
  } else if (writeTools.includes(tool) && project) {
    const target = String(args.file_path ?? args.notebook_path ?? '');
    if (target) {
      const path = await canonical(isAbsolute(target) ? target : resolve(input.cwd ?? project, target));
      if (implementer && within(resolve(project, '.project-os'), path) !== null) deny('The implementer changes project code only; .project-os belongs to the orchestrator and peos-run.');
      else if (!(await writeAllowed(project, path))) deny('Under .project-os/runs only the run\'s Markdown artifacts and pending-eval.json may be written; state, evidence and decisions belong to peos-run.');
    }
  } else if (tool === 'Bash') {
    const command = String(args.command ?? '');
    const flat = command.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
    const cwd = project && input.cwd ? await canonical(resolve(input.cwd)) : null;
    // A command touches PEOS state when it names .project-os, a protected file, or a glob
    // that could reach it, or runs with its working directory inside .project-os.
    const touches = /\.project-os/i.test(flat) || protectedFile.test(flat)
      || (/[*?[]/.test(flat) && /proj|runs/i.test(flat))
      || (cwd !== null && within(resolve(project, '.project-os'), cwd) !== null);
    if (implementer && (touches || /peos-run/i.test(flat))) deny('The implementer runs project commands only; run state is the orchestrator\'s.');
    else if (implementer && implementerGit(flat)) {
      deny('The implementer may only inspect Git (diff, status, log, show, ls-files, blame, grep); history, branches and uncommitted work are the user\'s.');
    }
    else if (/\bgrant\b[\s\S]*--(?:action|target)\b/i.test(flat)) deny('Only the user records decisions: ask them to type the /peos:approve, /peos:revise or /peos:retry command.');
    else if (/CLAUDECODE|\benv\s+(?:-[iu]|-(?:\s|$)|--ignore-environment|--unset)|\bunset\b/.test(flat)) deny('PEOS decisions depend on the Claude Code environment; commands that change it are refused.');
    else if (touches && !(await plainPeosRun(command)) && !plainGitReadOrAdd(command)) {
      deny('Shell commands do not touch .project-os: use peos-run for run state and evidence, and the Read or Write tools for files there.');
    }
  }
}
