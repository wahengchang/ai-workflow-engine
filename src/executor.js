import { spawn } from 'node:child_process';
import { AweError, assertAwe } from './errors.js';

function redactArguments(message, argv) {
  // Treat every positional argument and --option=value payload as private.
  // Do not guess which provider-specific flag names represent credentials.
  const values = argv.slice(1).flatMap(arg => {
    const equals = arg.indexOf('=');
    return [arg, ...(equals >= 0 ? [arg.slice(equals + 1)] : [])];
  }).filter(Boolean).sort((a, b) => b.length - a.length);
  // A single pass also avoids re-matching the replacement text itself.
  const pattern = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return pattern ? message.replace(new RegExp(pattern, 'g'), '[REDACTED]') : message;
}

export function getExecutionMode(executor) {
  if (executor?.type === 'echo') return 'SIMULATED';
  if (executor?.type === 'command') return 'COMMAND';
  return 'UNKNOWN';
}

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
    child.on('error', error => finish(new AweError('EXECUTOR_ERROR', redactArguments(`Failed to spawn ${options.argv[0]}: ${error.message}`, options.argv))));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (code === 0) finish(null, stdout.trimEnd());
      else finish(new AweError('EXECUTOR_FAILED', `Command exited ${code}: ${redactArguments(stderr.trim(), options.argv).slice(0, 1000)}`));
    });
    child.stdin.on('error', () => {}); // e.g. command exits before consuming stdin
    child.stdin.end(prompt);
  });
}
