// PreToolUse: keep run state, evidence and user decisions out of the model's reach.
// - Under .project-os/runs/ the model may write only the run's Markdown artifacts, the design preview and
//   pending-eval.json; everything else there belongs to peos-run.
// - Shell commands that touch .project-os (by text or working directory) are allowed
//   only as a plain call of this plugin's own peos-run, and never its `grant` action.
// - PEOS agents run no commands and write only their own output file (a producer its
//   artifact, an evaluator its report, the profiler the profile and missing instruction
//   files), so the orchestrator never copies their content; the implementer may change
//   project code but not .project-os or run peos-run.
// - MCP tools: no PEOS agent uses them, except the UI and design evaluators with browser
//   tools on the origin of a preview peos-run started for an active run (eval-ui.md §7).
// Shell inspection is a heuristic, not a sandbox: indirection (a script that builds the
// path itself) can evade it, which is why decisions also need a user-created grant.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInput, projectRoot, emit, activeRuns } from './common.mjs';
import { runningPreview } from '../scripts/lib/ui.mjs';

const peosRun = fileURLToPath(new URL('../scripts/peos-run.mjs', import.meta.url));
const writableArtifacts = ['task.md', 'idea.md', 'investigation.md', 'spec.md', 'architecture.md', 'design.md', 'design-preview.html', 'plan.md', 'summary.md', 'pending-eval.json'];
const pendingReport = /^pending-eval-[a-z0-9-]+\.json$/;
// The one run file each producer or evaluator may write.
const agentRunFile = { 'peos:spec-writer': name => name === 'spec.md', 'peos:architect': name => name === 'architecture.md', 'peos:designer': name => ['design.md', 'design-preview.html'].includes(name), 'peos:planner': name => name === 'plan.md' };
const writeTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const peosAgents = /^peos:(?:eval-[a-z-]+|spec-writer|architect|designer|planner|investigator|profiler)$/;
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
// A PEOS agent's write: its own run file, or for the profiler the profile and an
// instruction file that does not exist yet.
async function agentWriteAllowed(project, agent, path) {
  if (agent === 'peos:profiler') {
    if (path === resolve(project, '.project-os/project-profile.md')) return !(await lstat(path).catch(() => null))?.isSymbolicLink();
    return ['AGENTS.md', 'CLAUDE.md'].some(name => path === resolve(project, name)) && !(await lstat(path).catch(() => null));
  }
  const parts = within(resolve(project, '.project-os/runs'), path);
  if (parts === null || parts.length !== 2 || parts[0].startsWith('.')) return false;
  // An evaluator writes only reports named after itself: eval-code → pending-eval-code[-<focus>].json.
  const evaluator = /^peos:eval-([a-z]+)$/.exec(agent)?.[1];
  const own = agentRunFile[agent] ?? (evaluator ? name => new RegExp(`^pending-eval-${evaluator}(?:-[a-z]+)?\\.json$`).test(name) : () => false);
  // Only inside an existing run, never a directory the agent invents.
  const run = await lstat(resolve(project, '.project-os/runs', parts[0], 'state.json')).catch(() => null);
  return own(parts[1]) && Boolean(run?.isFile()) && !(await lstat(path).catch(() => null))?.isSymbolicLink();
}
async function writeAllowed(project, path) {
  const parts = within(resolve(project, '.project-os/runs'), path);
  if (parts === null) return true;
  if (parts.length !== 2 || parts[0].startsWith('.') || !(writableArtifacts.includes(parts[1].toLowerCase()) || pendingReport.test(parts[1]))) return false;
  const current = await lstat(path).catch(() => null);
  return !current?.isSymbolicLink();
}
// The UI evaluator looks at the run's own preview. Only the isolated browsers (the
// desktop app's built-in pane, Playwright), never the user's own Chrome; only tools that
// look, navigate or click (an allow-list, applied to every action of a batch); and every
// URL argument on the host and port of a preview an active run started and still runs.
const browserServer = /^mcp__((?:(?!__).)*(?:browser|playwright)(?:(?!__).)*)__/i;
const lookingTools = new Set(['navigate', 'navigate_back', 'navigate_forward', 'computer', 'screenshot', 'take_screenshot', 'snapshot', 'read_page',
  'get_page_text', 'find', 'resize', 'resize_window', 'tabs', 'tabs_context', 'tabs_create', 'tabs_select', 'click', 'hover', 'press_key',
  'wait_for', 'console_messages', 'read_console_messages', 'batch']);
// computer actions that only look, scroll, point or press keys; never typing text.
const lookingActions = new Set(['screenshot', 'zoom', 'scroll', 'scroll_to', 'wait', 'hover', 'left_click', 'double_click', 'key']);
const scheme = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:about|data|javascript|blob|file|view-source):)/i;
function urlArguments(value, key = '', found = []) {
  if (typeof value === 'string') {
    if (scheme.test(value) || /^(?:url|uri|href|link)$/i.test(key)) found.push(value);
  } else if (Array.isArray(value)) for (const item of value) urlArguments(item, key, found);
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) urlArguments(item, name, found);
  return found;
}
const toolName = name => String(name).replace(browserServer, '').replace(/^browser_/, '').replace(/_mcp$/, '');
// A refusal for one tool call or, for a batch, any call inside it.
function refusedTool(name, input) {
  const base = toolName(name);
  if (!lookingTools.has(base)) return `${base} is not a tool that only looks`;
  if (base === 'computer' && !lookingActions.has(String(input?.action))) return `computer ${input?.action} is not an action that only looks`;
  if (base === 'batch') {
    const actions = Array.isArray(input?.actions) ? input.actions : null;
    if (!actions) return 'a batch without an action list';
    for (const action of actions) {
      const reason = action && typeof action === 'object' && action.name !== undefined ? refusedTool(action.name, action.input) : 'a batch action without a name';
      if (reason) return reason;
    }
  }
  return null;
}
async function previewOrigins(project) {
  const origins = [];
  for (const { directory } of await activeRuns(project)) {
    const preview = await runningPreview(directory).catch(() => null);
    try { if (preview?.url) origins.push(new URL(preview.url).host); } catch { /* no usable preview */ }
  }
  return origins;
}
async function uiToolRefusal(project, tool, args) {
  if (!browserServer.test(tool)) return 'The UI evaluator uses only an isolated browser (the built-in browser pane or Playwright), never the user\'s Chrome.';
  const refused = refusedTool(tool, args);
  if (refused) return `The UI evaluator only looks and clicks: ${refused}.`;
  const urls = urlArguments(args).filter(value => !['back', 'forward'].includes(value));
  if (!urls.length) return null;
  const origins = project ? await previewOrigins(project) : [];
  for (const value of urls) {
    // Hosts are compared with their port; a URL without a scheme is one the browser completes.
    let host;
    try {
      const url = new URL(scheme.test(value) ? value : `http://${value}`);
      host = ['http:', 'https:'].includes(url.protocol) ? url.host : null;
    } catch { host = null; }
    if (!host || !origins.includes(host)) return `The UI evaluator may open only the run's preview (${origins.join(', ') || 'none running'}).`;
  }
  return null;
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
  const agent = typeof input.agent_type === 'string' && peosAgents.test(input.agent_type) ? input.agent_type : null;
  if (typeof tool === 'string' && tool.startsWith('mcp__')) {
    if (agent && !['peos:eval-ui', 'peos:eval-design'].includes(agent)) deny('PEOS agents other than the UI and design evaluators use no MCP tools.');
    else if (agent) { const reason = await uiToolRefusal(project, tool, args); if (reason) deny(reason); }
  } else if (typeof input.agent_type === 'string' && peosAgents.test(input.agent_type) && [...writeTools, 'Bash'].includes(tool)) {
    const target = tool === 'Write' && project ? String(args.file_path ?? '') : '';
    const path = target ? await canonical(isAbsolute(target) ? target : resolve(input.cwd ?? project, target)) : null;
    if (!path || !(await agentWriteAllowed(project, input.agent_type, path))) {
      deny('PEOS agents run no commands and write only their own output file named by the orchestrator.');
    }
  } else if (writeTools.includes(tool) && project) {
    const target = String(args.file_path ?? args.notebook_path ?? '');
    if (target) {
      const path = await canonical(isAbsolute(target) ? target : resolve(input.cwd ?? project, target));
      if (implementer && within(resolve(project, '.project-os'), path) !== null) deny('The implementer changes project code only; .project-os belongs to the orchestrator and peos-run.');
      else if (!(await writeAllowed(project, path))) deny('Under .project-os/runs only the run\'s Markdown artifacts and pending evaluation reports may be written; state, evidence and decisions belong to peos-run.');
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
