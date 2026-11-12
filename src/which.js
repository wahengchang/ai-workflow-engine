import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Where would the OS find this command? Returns the absolute path, or null.
export async function findExecutable(command, { cwd = process.cwd(), env = process.env } = {}) {
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  const candidates = command.includes('/') || command.includes(path.sep)
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const base of candidates) {
    for (const extension of extensions) {
      if (await executableFile(base + extension)) return base + extension;
    }
  }
  return null;
}

// AI command-line tools awe init can find on PATH, in order of preference.
export const KNOWN_AGENTS = [
  { name: 'claude', run: 'claude -p {prompt}' },
  { name: 'codex', run: 'codex exec {prompt}' },
  { name: 'opencode', run: 'opencode run {prompt}' },
  { name: 'omp', run: 'omp -p' },
];

export async function detectAgent(options) {
  for (const agent of KNOWN_AGENTS) {
    if (await findExecutable(agent.name, options)) return agent;
  }
  return null;
}
