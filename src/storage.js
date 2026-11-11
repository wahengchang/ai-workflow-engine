import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  async artifact(stepId, attempt, content, { exclusive = false } = {}) {
    const filename = `${stepId.replaceAll('.', '-')}-attempt-${attempt}.md`;
    const file = path.join(this.dir, 'artifacts', filename);
    // exclusive: never replace an earlier attempt's artifact.
    await writeFile(file, content, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' });
    return file;
  }
  // Declared output files are copied into a directory that belongs to one attempt only.
  fileDir(stepId, attempt) {
    return path.join(this.dir, 'artifacts', 'files', stepId.replaceAll('.', '-'), `attempt-${attempt}`);
  }
  async prompt(stepId, attempt, content) {
    const file = path.join(this.dir, 'artifacts', `prompt-${stepId.replaceAll('.', '-')}-attempt-${attempt}.md`);
    await writeFile(file, content, 'utf8');
    return file;
  }
}
