import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 65536;
const GRACE_MS = 200;
// Raw output is bounded in memory and never returned: arbitrary logs cannot be safely redacted.
export function runCheck(check, cwd, signal) {
  const started = performance.now();
  return new Promise(resolve => {
    let child, timer, escalation, cleanupDeadline, stopReason, spawnError, exited = false, finished = false;
    let exitCode = null, exitSignal = null;
    const output = { stdout: { bytes: 0, truncated: false }, stderr: { bytes: 0, truncated: false } };
    const buffers = { stdout: [], stderr: [] };
    function capture(stream, chunk) {
      const remaining = Math.max(0, OUTPUT_LIMIT - output[stream].bytes);
      if (remaining) buffers[stream].push(chunk.subarray(0, remaining));
      output[stream].bytes += chunk.length;
      output[stream].truncated = output[stream].bytes > OUTPUT_LIMIT;
    }
    function killGroup(sig) {
      if (!child?.pid) return;
      try { process.kill(-child.pid, sig); } catch (error) {
        if (error.code !== 'ESRCH') spawnError = 'Could not terminate the process group.';
      }
    }
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanupDeadline);
      signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (!exited) child?.unref();
      buffers.stdout.length = 0; buffers.stderr.length = 0;
      const blocked = [stopReason, spawnError].filter(Boolean).join(' ') || (exitSignal ? `Terminated by ${exitSignal}.` : null);
      resolve({ id: check.id, required: check.required,
        status: blocked ? 'BLOCKED' : exitCode === 0 ? 'PASS' : 'FAIL',
        exitCode, signal: exitSignal, durationMs: Math.round(performance.now() - started),
        reason: blocked || (exitCode === 0 ? null : `Exited with code ${exitCode}.`),
        output: { policy: 'contents suppressed', limitBytesPerStream: OUTPUT_LIMIT, ...output }
      });
    }
    function stop(reason) {
      if (stopReason || finished) return;
      stopReason = reason;
      clearTimeout(timer);
      killGroup('SIGTERM');
      // Always escalate even if the direct child exits: grandchildren may ignore SIGTERM.
      escalation = setTimeout(() => {
        killGroup('SIGKILL');
        if (exited || !child?.pid) finish();
        else {
          child.once('close', finish);
          cleanupDeadline = setTimeout(() => {
            spawnError = 'Process cleanup could not be confirmed after SIGKILL.';
            finish();
          }, 1000);
        }
      }, GRACE_MS);
    }
    function cancel() { stop(`Interrupted by ${signal.reason || 'cancellation'}.`); }
    if (signal?.aborted) { stopReason = `Interrupted by ${signal.reason}.`; finish(); return; }
    try {
      child = spawn(check.executable, check.args, { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      spawnError = 'Process startup failed.'; finish(); return;
    }
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.on('error', error => { spawnError = `Process startup/execution failed (${error.code || 'unknown'}).`; });
    child.on('exit', (code, sig) => { exited = true; exitCode = code; exitSignal = sig; });
    child.on('close', () => { if (!stopReason) finish(); });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop(`Timed out after ${check.timeoutMs} ms.`), check.timeoutMs);
  });
}
