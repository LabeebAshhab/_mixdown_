// The only place external programs are started.
//   - never through a shell: arguments are passed as an array, so nothing a
//     visitor types can be interpreted as a command
//   - a hard timeout kills the process (SIGKILL) when it runs too long
//   - the child gets a minimal environment, not the server's
import { spawn } from 'node:child_process';

const PASS_ENV = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME'];
const childEnv = Object.fromEntries(PASS_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
childEnv.LANG = 'C.UTF-8';

export class ProcError extends Error {
  /** @param {'timeout'|'aborted'|'not-installed'|'spawn-failed'|'exit'|'bad-args'|'output-too-large'} kind */
  constructor(kind, detail = '') {
    super(`process ${kind}`);
    this.kind = kind;
    this.detail = detail; // internal only, never sent to a client
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeout?: number, signal?: AbortSignal, onLine?: (line: string) => void, maxOutput?: number, stderr?: boolean}} [opts]
 * @returns {Promise<string>} stdout (empty when onLine is used); with `stderr: true`, the last 4000 characters of stderr instead
 */
export function run(cmd, args, { timeout = 60_000, signal, onLine, maxOutput = 64 * 1024 * 1024, stderr = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
      return reject(new ProcError('bad-args'));
    }
    if (signal?.aborted) return reject(new ProcError('aborted'));

    let child;
    try {
      child = spawn(cmd, args, { shell: false, windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new ProcError('spawn-failed', e.message));
    }

    let out = '';
    let err = '';
    let buf = '';
    let reason = null;
    let settled = false;
    const kill = (why) => {
      reason ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), timeout);
    const onAbort = () => kill('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stderr ? err : out);
    };

    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onLine) {
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop().slice(-4096);
        lines.forEach(onLine);
      } else {
        out += s;
        if (out.length > maxOutput) kill('output-too-large');
      }
    });
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on('error', (e) => finish(new ProcError(e.code === 'ENOENT' ? 'not-installed' : 'spawn-failed', e.message)));
    child.on('close', (code) => {
      if (reason) finish(new ProcError(reason, err.trim()));
      else if (code === 0) finish(null);
      else finish(new ProcError('exit', err.trim() || `exit code ${code}`));
    });
  });
}
