import { mkdir, readFile, rename, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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

  // Write the exact bytes of a source-run artifact into this run's artifacts dir.
  // The name matches artifact() so reused artifacts keep their fingerprint semantics.
  async copyArtifact(stepId, attempt, content) {
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
  if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid run ID');
  return JSON.parse(await readFile(path.join(root, '.awe', 'runs', runId, 'state.json'), 'utf8'));
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export async function sha256File(file) {
  return sha256(await readFile(file));
}

// The source run's artifacts directory must be a real directory inside the
// workflow's own .awe/runs tree. Comparing against realpath alone is not
// enough: moving the directory outside and symlinking it back makes both sides
// agree. Resolve the run dir from the real workflow root and reject a symlinked
// run directory or artifacts directory before any artifact is read.
export async function verifiedArtifactsDir(root, runId) {
  if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId)) {
    throw new AweError('PARTIAL_ARTIFACT_MISSING', `Invalid source run ID: ${runId}`);
  }
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) throw new AweError('PARTIAL_ARTIFACT_MISSING', `Workflow root ${root} does not resolve`);
  const runDir = path.join(rootReal, '.awe', 'runs', runId);
  const artifactsDir = path.join(runDir, 'artifacts');
  for (const [label, dir] of [['run directory', runDir], ['artifacts directory', artifactsDir]]) {
    const info = await lstat(dir).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) {
      throw new AweError('PARTIAL_ARTIFACT_MISSING', `Source ${label} ${dir} is missing, not a directory, or a symlink`);
    }
  }
  const realArtifacts = await realpath(artifactsDir).catch(() => null);
  if (realArtifacts !== artifactsDir) {
    throw new AweError('PARTIAL_ARTIFACT_MISSING', `Source artifacts ${artifactsDir} escapes the source run through a symlinked path`);
  }
  // Return the directory as the workflow records it (the caller compares
  // recorded artifact paths); containment was proven through the real root.
  return path.join(path.resolve(root), '.awe', 'runs', runId, 'artifacts');
}

// A reusable artifact must be reached as a normal file inside the source run's
// own artifacts directory. Every component below that directory is inspected
// with lstat so neither a symlinked file nor a symlinked subdirectory can hide
// a path outside the run, even when realpath comparisons would agree.
export async function safeArtifactPath(artifactsDir, artifact) {
  if (typeof artifact !== 'string' || !artifact) {
    throw new AweError('PARTIAL_ARTIFACT_MISSING', 'Artifact path missing');
  }
  const resolved = path.resolve(artifact);
  const expected = path.resolve(artifactsDir);
  if (!resolved.startsWith(expected + path.sep)) {
    throw new AweError('PARTIAL_ARTIFACT_MISSING', `Artifact ${resolved} is outside the source run directory`);
  }
  let current = expected;
  for (const segment of path.relative(expected, resolved).split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new AweError('PARTIAL_ARTIFACT_MISSING', `Artifact ${resolved} is missing from the source run`);
    if (info.isSymbolicLink()) {
      throw new AweError('PARTIAL_ARTIFACT_MISSING', `Artifact ${resolved} is reached through a symlinked path`);
    }
  }
  const realExpected = await realpath(expected).catch(() => null);
  const realResolved = await realpath(resolved).catch(() => null);
  if (!realExpected || !realResolved || !realResolved.startsWith(realExpected + path.sep)) {
    throw new AweError('PARTIAL_ARTIFACT_MISSING', `Artifact ${resolved} escapes the source run directory through a symlinked path`);
  }
  return resolved;
}
