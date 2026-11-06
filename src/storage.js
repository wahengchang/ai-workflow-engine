import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AweError } from './errors.js';

export class RunStore {
  constructor(root, runId) {
    this.runId = runId ?? `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.dir = path.join(root, '.awe', 'runs', this.runId);
    this.statePath = path.join(this.dir, 'state.json');
    this.pending = Promise.resolve();
  }
  async initialize(state) {
    await mkdir(path.join(this.dir, 'artifacts'), { recursive: true });
    await this.save(state);
  }
  async save(state) {
    // Serialize and snapshot before queueing so parallel completions never overwrite with stale snapshots.
    const data = JSON.stringify(state, null, 2) + '\n';
    this.pending = this.pending.then(async () => {
      const tempfile = this.statePath + '.' + randomUUID() + '.tmp';
      await writeFile(tempfile, data);
      await rename(tempfile, this.statePath);
    });
    await this.pending;
  }
  async artifact(stepId, attempt, content) {
    const filename = `${stepId.replaceAll('.', '-')}-attempt-${attempt}.md`;
    const file = path.join(this.dir, 'artifacts', filename);
    await writeFile(file, content, 'utf8');
    return file;
  }
  async prompt(stepId, attempt, content) {
    const file = path.join(this.dir, 'artifacts', `prompt-${stepId.replaceAll('.', '-')}-attempt-${attempt}.md`);
    await writeFile(file, content, 'utf8');
    return file;
  }
}

export async function readRun(root, runId) {
  if (!/^[\w-]+$/.test(runId)) throw new AweError('INVALID_RUN_ID', 'Invalid run ID');
  try {
    return JSON.parse(await readFile(path.join(root, '.awe', 'runs', runId, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AweError('RUN_NOT_FOUND', `Run ${runId} not found under ${root}. Use --workflow PATH to select its workflow directory.`);
    throw error;
  }
}
