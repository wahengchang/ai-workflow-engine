import { spawn } from 'node:child_process';
import { AweError, assertAwe } from './errors.js';
import { PLACEHOLDER, usesPlaceholder, isPlainToken } from './command.js';

// Longest prompt placed directly into one argument. Above this, {prompt} becomes a short
// instruction that points at the saved prompt file (a single argument is limited to ~128 KB on
// Linux and a whole command line to ~32 KB on Windows).
export const MAX_INLINE_PROMPT_BYTES = process.platform === 'win32' ? 16_000 : 64_000;
const STDERR_KEEP_BYTES = 64_000;
export const STDERR_TAIL_LINES = 20;

function redactArguments(message, argv) {
  // Treat every other positional argument and --option=value payload as private.
  // Do not guess which provider-specific flag names represent credentials.
  const values = argv.slice(1).filter(token => !isPlainToken(token)).flatMap(arg => {
    const equals = arg.indexOf('=');
    return [arg, ...(equals >= 0 ? [arg.slice(equals + 1)] : [])];
  }).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!values.length) return message;
  // Literal matching, longest value first, one pass: no pattern-size limit (a rendered prompt can be
  // tens of KB) and the replacement text is never re-matched.
  let out = '';
  for (let i = 0; i < message.length;) {
    const hit = values.find(value => message.startsWith(value, i));
    if (hit) { out += '[REDACTED]'; i += hit.length; } else out += message[i++];
  }
  return out;
}

export function tailLines(text, count = STDERR_TAIL_LINES) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.slice(-count).join('\n');
}

// Template tokens -> real argv. {prompt_file} is the saved file's absolute path; {prompt} is the
// rendered prompt itself, or (when too long) a one-line instruction to read that file.
export function buildArgv(template, prompt, promptFile) {
  const long = Buffer.byteLength(prompt, 'utf8') > MAX_INLINE_PROMPT_BYTES;
  return template.map(token => token.replace(PLACEHOLDER, match => {
    if (match === '{prompt_file}') return promptFile;
    return long ? `Read and follow the instructions in the file: ${promptFile}` : prompt;
  }));
}

export function needsPromptFile(template, prompt) {
  return template.some(token => token.includes('{prompt_file}')) || (template.some(token => token.includes('{prompt}')) && Buffer.byteLength(prompt, 'utf8') > MAX_INLINE_PROMPT_BYTES);
}

// options: { argv (template), cwd, signal, timeoutMs, promptFile, onStderr(tail) }
export async function executePrompt(prompt, options) {
  if (options.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
  const template = options.argv;
  assertAwe(Array.isArray(template) && template.length > 0 && template.every(a => typeof a === 'string'), 'INVALID_EXECUTOR', 'Executor requires argv: [executable, ...args]');
  const timeoutMs = options.timeoutMs ?? 300000;
  assertAwe(Number.isInteger(timeoutMs) && timeoutMs > 0, 'INVALID_EXECUTOR', 'timeoutMs must be a positive integer');
  if (needsPromptFile(template, prompt)) assertAwe(options.promptFile, 'INVALID_EXECUTOR', 'This command needs a prompt file but none was saved');
  const argv = buildArgv(template, prompt, options.promptFile);
  const viaStdin = !usesPlaceholder(template);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let ended = false;
    const tail = () => redactArguments(tailLines(stderr), argv);
    const finish = (error, output) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', interrupt);
      try { options.onStderr?.(tail()); } catch { /* observers must not break the run */ }
      if (error) { error.stderrTail = tail(); reject(error); } else resolve(output);
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
      const seconds = +(timeoutMs / 1000).toFixed(1);
      finish(new AweError('EXECUTOR_TIMEOUT', `Command timed out after ${seconds}s. Raise it with --timeout <seconds> or "timeout" in awe.json.`));
    }, timeoutMs);
    options.signal?.addEventListener('abort', interrupt, { once: true });
    child.on('error', error => finish(new AweError('EXECUTOR_ERROR', redactArguments(`Failed to start ${argv[0]}: ${error.code === 'ENOENT' ? 'command not found. Install it, or fix "run" in awe.json (awe check shows the executor status)' : error.message}`, argv))));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > STDERR_KEEP_BYTES) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });
    child.on('close', (code, signal) => {
      if (code === 0) finish(null, stdout.trimEnd());
      else if (signal) {
        // Killed from outside AWE (OOM killer, kill -9, ...): it may have acted before dying.
        const error = new AweError('EXECUTOR_FAILED', `Command was terminated by signal ${signal}: ${redactArguments(stderr.trim(), argv).slice(0, 1000)}`);
        error.signal = signal;
        finish(error);
      } else finish(new AweError('EXECUTOR_FAILED', `Command exited ${code}: ${redactArguments(stderr.trim(), argv).slice(0, 1000)}`));
    });
    child.stdin.on('error', () => {}); // e.g. command exits before consuming stdin
    if (viaStdin) child.stdin.end(prompt); else child.stdin.end();
  });
}
