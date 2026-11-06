import { spawn } from 'node:child_process';
import { AweError, assertAwe } from './errors.js';

export async function executePrompt(prompt, options) {
  if (options.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
  if (options.type === 'echo') return prompt;
  assertAwe(options.type === 'command', 'INVALID_EXECUTOR', 'Executor type must be echo or command');
  assertAwe(Array.isArray(options.argv) && options.argv.length > 0 && options.argv.every(a => typeof a === 'string'), 'INVALID_EXECUTOR', 'Command executor requires argv: [executable, ...args]');
  const timeoutMs = options.timeoutMs ?? 120000;
  assertAwe(Number.isInteger(timeoutMs) && timeoutMs > 0, 'INVALID_EXECUTOR', 'timeoutMs must be a positive integer');
  return new Promise((resolve, reject) => {
    const child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let ended = false;
    const finish = (error, output) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', interrupt);
      if (error) reject(error); else resolve(output);
    };
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const interrupt = () => {
      kill();
      finish(new AweError('RUN_INTERRUPTED', 'Run interrupted'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new AweError('EXECUTOR_TIMEOUT', `Command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    options.signal?.addEventListener('abort', interrupt, { once: true });
    child.on('error', error => finish(new AweError('EXECUTOR_ERROR', `Failed to spawn ${options.argv[0]}: ${error.message}`)));
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      if (code === 0) finish(null, stdout.trimEnd());
      else finish(new AweError('EXECUTOR_FAILED', `Command exited ${code}: ${stderr.trim().slice(0, 1000)}`));
    });
    child.stdin.on('error', () => {}); // e.g. command exits before consuming stdin
    child.stdin.end(prompt);
  });
}
