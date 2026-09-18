import { realpath, stat } from 'node:fs/promises';

export class ToolkitError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function fail(code, message) { throw new ToolkitError(code, message); }

export function parseArgs(argv, valueOptions, flagOptions = ['json']) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if ((!valueOptions.includes(key) && !flagOptions.includes(key)) || Object.hasOwn(options, key)) {
      fail('INVOCATION', 'Unknown, positional, or repeated option. Consult integrations/codex.md.');
    }
    if (flagOptions.includes(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail('INVOCATION', `--${key} requires a value.`);
      options[key] = value;
    }
  }
  return options;
}
export async function projectDirectory(value) {
  if (!value) fail('INVOCATION', 'An explicit --project directory is required.');
  try {
    const root = await realpath(value);
    if (!(await stat(root)).isDirectory()) throw new Error();
    return root;
  } catch { fail('PROJECT', 'The target project must be an existing readable directory.'); }
}
export function requirePlatform() {
  if (!['darwin', 'linux'].includes(process.platform)) {
    fail('PLATFORM', 'This version requires POSIX process groups (macOS; Linux unverified). Windows is unsupported.');
  }
}
export async function main(run, render) {
  const json = process.argv.slice(2).includes('--json');
  try {
    const { report, exitCode = 0 } = await run();
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${render(report)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    const report = { reportVersion: 1, status: 'ERROR', error: {
      code: error instanceof ToolkitError ? error.code : 'INTERNAL',
      message: error instanceof ToolkitError ? error.message : 'Unexpected toolkit failure; raw diagnostics suppressed.'
    }};
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `ERROR ${report.error.code}: ${report.error.message}\n`);
    process.exitCode = 2;
  }
}
