import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { AweError } from './errors.js';
import { canonical } from './digest.js';

// Dev cache lives under .awe/dev/<session>/session.json. It is a separate namespace
// from .awe/runs: awe run never reads or writes it, and awe dev never imports a run.
export const SESSION_SCHEMA = 1;
const SESSION_ID = /^dev-[\w-]+$/;
const HISTORY_LIMIT = 20;

export async function atomicWrite(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

// A per-workspace random key: digests of argv/inputs cannot be brute-forced from session.json alone.
export async function workspaceSalt(root) {
  const base = path.join(root, '.awe', 'dev');
  await mkdir(base, { recursive: true });
  const file = path.join(base, '.salt');
  try {
    await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return (await readFile(file, 'utf8')).trim();
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function readLock(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function acquireLock(dir, sessionId) {
  const file = path.join(dir, 'lock');
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() });
  for (let tries = 0; tries < 3; tries++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(body); } finally { await handle.close(); }
      return {
        async release() {
          const current = await readLock(file);
          if (current?.token === token) await unlink(file).catch(() => {});
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readLock(file);
      let stale = false;
      if (holder) stale = holder.host === os.hostname() && !pidAlive(holder.pid);
      else {
        // Unreadable lock: probably being written right now; only a long-abandoned one is stale.
        const info = await stat(file).catch(() => null);
        stale = !info || Date.now() - info.mtimeMs > 30000;
      }
      if (!stale) {
        throw new AweError('DEV_SESSION_BUSY', `Dev session ${sessionId} is in use by another awe dev process${holder ? ` (pid ${holder.pid})` : ''}. Wait for it to finish, or start an independent session with --fresh.`);
      }
      // Break the stale lock by renaming it away; if we grabbed a live one by mistake, put it back.
      const aside = `${file}.stale-${randomUUID()}`;
      try { await rename(file, aside); } catch { continue; }
      const moved = await readLock(aside);
      if (holder && moved?.token !== holder.token) {
        await rename(aside, file).catch(() => {});
        throw new AweError('DEV_SESSION_BUSY', `Dev session ${sessionId} is in use by another awe dev process.`);
      }
      await unlink(aside).catch(() => {});
    }
  }
  throw new AweError('DEV_SESSION_BUSY', `Could not lock dev session ${sessionId}; try again.`);
}

async function readSession(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data === 'object' && data.schema === SESSION_SCHEMA && data.records && typeof data.records === 'object' ? data : null;
  } catch {
    return null;
  }
}

const blankRecord = (address, stepId) => ({ address, stepId, latest: null, pending: null, unknown: null, lastFailure: null, history: [] });

export class DevSession {
  constructor(dir, data, lock, created) {
    this.dir = dir;
    this.data = data;
    this.lock = lock;
    this.created = created;
    this.pending = Promise.resolve();
  }
  get id() { return this.data.id; }
  record(address) { return this.data.records[address]; }
  records() { return Object.values(this.data.records); }
  ensure(address, stepId) { return (this.data.records[address] ??= blankRecord(address, stepId)); }
  // Same snapshot-then-queue pattern as RunStore.save: parallel branches never write stale snapshots.
  async save() {
    const text = JSON.stringify(this.data, null, 2) + '\n';
    this.pending = this.pending.then(() => atomicWrite(path.join(this.dir, 'session.json'), text));
    await this.pending;
  }
  #history(record, entry) {
    record.history = [...record.history, { ...entry, at: new Date().toISOString() }].slice(-HISTORY_LIMIT);
  }
  // Intent is durable before the executor starts. It also retires the previous success: if this
  // attempt fails or crashes, the old result must never be silently used again.
  async begin(address, stepId, intent) {
    const record = this.ensure(address, stepId);
    if (record.latest) this.#history(record, { status: 'SUPERSEDED', resultId: record.latest.resultId, runId: record.latest.runId, attempt: record.latest.attempt });
    record.latest = null;
    record.unknown = null;
    record.pending = intent;
    await this.save();
  }
  async commit(address, latest) {
    const record = this.data.records[address];
    record.latest = latest;
    record.pending = null;
    record.unknown = null;
    record.lastFailure = null;
    this.#history(record, { status: 'COMPLETED', resultId: latest.resultId, runId: latest.runId, attempt: latest.attempt });
    await this.save();
  }
  async fail(address, failure) {
    const record = this.data.records[address];
    record.pending = null;
    record.lastFailure = { runId: failure.runId, attempt: failure.attempt, code: failure.code, message: failure.message, at: new Date().toISOString() };
    if (failure.unknown) record.unknown = { runId: failure.runId, attempt: failure.attempt, reason: failure.code, at: new Date().toISOString() };
    this.#history(record, { status: failure.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED', runId: failure.runId, attempt: failure.attempt, code: failure.code });
    await this.save();
  }
  async invalidate(address, reason) {
    const record = this.data.records[address];
    if (!record?.latest) return;
    this.#history(record, { status: 'INVALIDATED', resultId: record.latest.resultId, runId: record.latest.runId, attempt: record.latest.attempt, reason });
    record.latest = null;
    await this.save();
  }
  // A leftover intent means a previous process died between "about to run" and "recorded".
  // We hold the session lock, so nothing is running: the outcome is unknown, not "in progress".
  async reconcile(root, executorType) {
    const orphans = this.records().filter(record => record.pending);
    for (const record of orphans) {
      const { runId, attempt } = record.pending;
      record.lastFailure = { runId, attempt, code: 'ORPHANED_INTENT', message: 'The process stopped before this attempt was recorded', at: new Date().toISOString() };
      if (executorType === 'command') record.unknown = { runId, attempt, reason: 'ORPHANED_INTENT', at: new Date().toISOString() };
      this.#history(record, { status: 'ORPHANED', runId, attempt });
      record.pending = null;
      await markRunAbandoned(root, runId, record.stepId);
    }
    if (orphans.length) await this.save();
    return orphans.map(record => record.address);
  }
  unknownAddresses() { return this.records().filter(record => record.unknown).map(record => record.address); }
  async finish(runId) {
    this.data.lastUsedAt = new Date().toISOString();
    this.data.lastRunId = runId;
    await this.save();
  }
  async release() {
    await this.pending.catch(() => {});
    await this.lock.release();
  }
}

async function markRunAbandoned(root, runId, stepId) {
  if (!/^[\w-]+$/.test(runId)) return;
  const file = path.join(root, '.awe', 'runs', runId, 'state.json');
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.status !== 'RUNNING') return;
    const error = { code: 'RUN_ABANDONED', message: 'The process stopped before this run finished' };
    state.status = 'FAILED';
    state.error = error;
    state.finishedAt = new Date().toISOString();
    for (const step of Object.values(state.steps ?? {})) {
      if (step.status === 'RUNNING') step.status = 'FAILED', step.error = error;
    }
    for (const invocation of state.invocations ?? []) {
      if (invocation.status === 'RUNNING') invocation.status = 'FAILED', invocation.error = error;
    }
    await atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
  } catch { /* best effort: the session record already carries the facts */ }
}

export async function openSession(root, compat, { fresh = false } = {}) {
  const base = path.join(root, '.awe', 'dev');
  await mkdir(base, { recursive: true });
  const wanted = canonical(compat);
  if (!fresh) {
    const candidates = [];
    for (const name of await readdir(base).catch(() => [])) {
      if (!SESSION_ID.test(name)) continue;
      const data = await readSession(path.join(base, name, 'session.json'));
      if (data?.id === name && canonical(data.compat) === wanted) candidates.push(data);
    }
    candidates.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || b.id.localeCompare(a.id));
    if (candidates.length) {
      const dir = path.join(base, candidates[0].id);
      const lock = await acquireLock(dir, candidates[0].id);
      // State may have changed between the scan and the lock: always continue from disk.
      const data = await readSession(path.join(dir, 'session.json'));
      if (data?.id === candidates[0].id && canonical(data.compat) === wanted) return new DevSession(dir, data, lock, false);
      await lock.release();
    }
  }
  const id = `dev-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(base, id);
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(dir, id);
  const now = new Date().toISOString();
  const session = new DevSession(dir, { schema: SESSION_SCHEMA, id, createdAt: now, lastUsedAt: now, lastRunId: null, compat, records: {} }, lock, true);
  await session.save();
  return session;
}
