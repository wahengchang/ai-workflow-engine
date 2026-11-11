import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workspace, put, run, resume, calls, countByStep, projectRoot, flow, agentCommand } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';

const bin = path.join(projectRoot, 'bin', 'awe.js');
const crashScript = path.join(projectRoot, 'fixtures', 'crash.mjs');
// These tests send real POSIX signals to a child awe process; Windows has no equivalent.
const posix = { skip: process.platform === 'win32' && 'needs POSIX signals' };

function launch(script, args, cwd) {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, out, err })));
  return { child, done };
}
const awe = (ws, args = []) => launch(bin, ['run', ws.dir, '--cache', ...args], ws.dir);

async function waitFor(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const started = (ws, step) => waitFor(async () => (await calls(ws.log)).some(c => c.step === step), `step ${step} to start`);

async function sessionFile(dir) {
  const base = path.join(dir, '.awe', 'cache');
  const [id] = (await readdir(base)).filter(name => name.startsWith('cache-'));
  return { id, file: path.join(base, id, 'session.json'), data: JSON.parse(await readFile(path.join(base, id, 'session.json'), 'utf8')) };
}
async function runStates(dir) {
  const base = path.join(dir, '.awe', 'runs');
  return Promise.all((await readdir(base)).sort().map(async id => JSON.parse(await readFile(path.join(base, id, 'state.json'), 'utf8'))));
}
async function walkFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(full)); else found.push(full);
  }
  return found;
}

const slowFlow = {
  'slow.flag': 'x',
  '1.1-a.md': 'OUTPUT::a#{n}',
  '1.2-slow.md': 'SLEEP_WHILE::slow.flag::8000\nSide effects happen here.\nOUTPUT::slow#{n}',
  '1.3-c.md': 'S={{ steps["1.2"].output }}\nOUTPUT::c#{n}',
};

test('SIGINT interrupts cleanly; the interrupted command is never resent without --retry', posix, async t => {
  const ws = await workspace(t, slowFlow);
  const run = awe(ws);
  await started(ws, '1.2');
  run.child.kill('SIGINT');
  const exit = await run.done;
  assert.equal(exit.code, 130);

  const [state] = await runStates(ws.dir);
  assert.equal(state.status, 'INTERRUPTED');
  assert.equal(state.steps['1.2'].status, 'INTERRUPTED');
  assert.equal(state.steps['1.1'].status, 'COMPLETED');
  const { data } = await sessionFile(ws.dir);
  assert.equal(data.records['1.2'].latest, null);
  assert.equal(data.records['1.2'].unknown.reason, 'RUN_INTERRUPTED');
  assert.equal(data.records['1.1'].latest.attempt, 1, 'finished work is kept');

  await rm(path.join(ws.dir, 'slow.flag'));
  const refused = await resume(ws);
  assert.equal(refused.status, 'FAILED');
  assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
  assert.match(refused.error.message, /--retry 1\.2/);
  assert.equal((await countByStep(ws.log))['1.2'], 1, 'the executor was not started again');

  await assert.rejects(resume(ws, ['--retry', '1.3']), { code: 'RETRY_UNKNOWN' });
  const resumed = await resume(ws, ['--retry', '1.2']);
  assert.equal(resumed.status, 'COMPLETED');
  assert.deepEqual([resumed.executed, resumed.reused], [2, 1]);
  assert.equal((await countByStep(ws.log))['1.2'], 2);
  const again = await resume(ws);
  assert.deepEqual([again.executed, again.reused], [0, 3], 'the acknowledgement was a one-time pass');
});

test('a SIGKILLed process leaves an intent behind: unknown outcome, stale lock recovered, abandoned run marked', posix, async t => {
  const ws = await workspace(t, slowFlow);
  const run = awe(ws);
  await started(ws, '1.2');
  run.child.kill('SIGKILL');
  assert.equal((await run.done).signal, 'SIGKILL');

  const before = await sessionFile(ws.dir);
  assert.ok(before.data.records['1.2'].pending, 'the durable intent is still there');
  assert.equal(before.data.records['1.2'].latest, null);
  assert.equal((await runStates(ws.dir))[0].status, 'RUNNING');
  assert.ok((await stat(path.join(ws.dir, '.awe', 'cache', before.id, 'lock'))).isFile(), 'the dead process left its lock');

  await rm(path.join(ws.dir, 'slow.flag'));
  const refused = await resume(ws);
  assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
  assert.equal((await countByStep(ws.log))['1.2'], 1);
  const [crashed] = await runStates(ws.dir);
  assert.equal(crashed.status, 'FAILED');
  assert.equal(crashed.error.code, 'RUN_ABANDONED');
  assert.equal(crashed.steps['1.2'].status, 'FAILED');

  const done = await resume(ws, ['--retry', '1.2']);
  assert.equal(done.status, 'COMPLETED');
});

// Crash at each commit boundary of a step that has both stdout and a declared file.
const makeAndUse = {
  '1.1-make.md': 'WRITE::out/r.txt::file {n}\nOUTPUT::made#{n}',
  '1.2-use.md': 'Out={{ steps["1.1"].output }} File={{ steps["1.1"].files["r"] }}\nOUTPUT::used',
};
const declared = { steps: { '1.1': { outputs: [{ name: 'r', path: 'out/r.txt' }] } } };
for (const stage of ['afterIntent', 'afterExecute', 'afterArtifact', 'afterFiles', 'beforeCommit']) {
  test(`crash at ${stage}: the half-written attempt is never a valid result`, posix, async t => {
    const ws = await workspace(t, makeAndUse, declared);
    const crash = await launch(crashScript, [ws.dir, stage], ws.dir).done;
    assert.equal(crash.signal, 'SIGKILL');
    const executorRan = stage !== 'afterIntent';
    assert.equal((await countByStep(ws.log))['1.1'] ?? 0, executorRan ? 1 : 0);

    const { data } = await sessionFile(ws.dir);
    assert.equal(data.records['1.1'].latest, null, 'no valid result was committed');
    assert.ok(data.records['1.1'].pending);

    const refused = await resume(ws);
    assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
    assert.equal((await countByStep(ws.log))['1.1'] ?? 0, executorRan ? 1 : 0, 'not resent');

    const done = await resume(ws, ['--retry', '1.1']);
    assert.equal(done.status, 'COMPLETED', JSON.stringify(done.error));
    assert.deepEqual([done.executed, done.reused], [2, 0]);
    assert.notEqual(path.dirname(done.steps['1.1'].files.r.path).split(path.sep).at(-4), (await runStates(ws.dir))[0].runId, 'the new copy lives in the new run');
    assert.match(await readFile(done.steps['1.1'].files.r.path, 'utf8'), /^file \d$/);
    assert.match((await calls(ws.log)).find(c => c.step === '1.2').prompt, new RegExp(`File=${done.steps['1.1'].files.r.path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
}

test('crash right after the commit: the committed result is valid and reused', posix, async t => {
  const ws = await workspace(t, makeAndUse, declared);
  const crash = await launch(crashScript, [ws.dir, 'afterCommit'], ws.dir).done;
  assert.equal(crash.signal, 'SIGKILL');
  const next = await resume(ws);
  assert.equal(next.status, 'COMPLETED');
  assert.deepEqual([next.executed, next.reused], [1, 1]);
  assert.equal((await countByStep(ws.log))['1.1'], 1);
});

test('a timed-out command has an unknown outcome and needs an acknowledgement; a plain failure does not', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'SLEEP::3000\nOUTPUT::a', 'stop.flag': 'x', '1.2-b.md': 'FAIL_IF_EXISTS::stop.flag\nOUTPUT::b' }, { timeout: 0.3 });
  const slow = await resume(ws);
  assert.equal(slow.error.code, 'EXECUTOR_TIMEOUT');
  const refused = await resume(ws);
  assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
  await put(ws.dir, '1.1-a.md', 'OUTPUT::a');
  assert.equal((await resume(ws)).error.code, 'UNKNOWN_EFFECT', 'editing the prompt does not wipe the unknown outcome');
  const ok = await resume(ws, ['--retry', '1.1']);
  assert.equal(ok.error.code, 'EXECUTOR_FAILED', 'now 1.1 completes and 1.2 fails normally');
  await rm(path.join(ws.dir, 'stop.flag'));
  assert.equal((await resume(ws)).status, 'COMPLETED', 'a non-zero exit is a known failure: rerun needs no acknowledgement');
});

test('only one writer at a time; the second run is refused without executing anything', posix, async t => {
  const ws = await workspace(t, slowFlow);
  const first = awe(ws);
  await started(ws, '1.2');
  const second = await launch(bin, ['run', ws.dir, '--cache', '--json'], ws.dir).done;
  assert.equal(second.code, 2);
  assert.match(second.out, /CACHE_BUSY/);
  assert.equal((await countByStep(ws.log))['1.1'], 1, 'the second writer did not execute anything');
  await assert.rejects(resume(ws), { code: 'CACHE_BUSY', message: /Another awe run is using this workflow's cache/ });

  first.child.kill('SIGKILL');
  await first.done;
  for (const name of (await readdir(path.join(ws.dir, '.awe', 'cache'))).filter(n => n.startsWith('cache-'))) {
    JSON.parse(await readFile(path.join(ws.dir, '.awe', 'cache', name, 'session.json'), 'utf8'));
  }
});

test('locks: a dead owner is taken over; a live owner or another host is respected', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a#{n}' });
  const first = await resume(ws);
  const lockFile = path.join(ws.dir, '.awe', 'cache', first.session, 'lock');
  await assert.rejects(stat(lockFile), { code: 'ENOENT' }, 'the lock is released after a command');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('close', resolve));
  const lock = (pid, host) => writeFile(lockFile, JSON.stringify({ pid, host, token: 'test', at: new Date().toISOString() }));

  await lock(process.pid, 'some-other-host');
  await assert.rejects(resume(ws), { code: 'CACHE_BUSY' });
  await lock(process.pid, os.hostname());
  await assert.rejects(resume(ws), { code: 'CACHE_BUSY' });
  assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).token, 'test', 'a refused command leaves the owner lock alone');
  await lock(dead.pid, os.hostname());
  const taken = await resume(ws);
  assert.equal(taken.status, 'COMPLETED');
  assert.equal(taken.session, first.session);
  assert.equal(taken.reused, 1);
  await assert.rejects(stat(lockFile), { code: 'ENOENT' });
  assert.equal((await countByStep(ws.log))['1.1'], 1);
});

test('parallel branches write the shared session safely and leave no temporary files', async t => {
  const files = { '1.1-fan/FLOW.json': flow({ type: 'parallel' }) };
  for (let n = 1; n <= 12; n++) files[`1.1-fan/1.1.${n}-b.md`] = `OUTPUT::b${n}`;
  const ws = await workspace(t, files);
  const state = await resume(ws);
  assert.equal(state.status, 'COMPLETED');
  const { data } = await sessionFile(ws.dir);
  assert.equal(Object.values(data.records).filter(r => r.latest).length, 12);
  assert.equal((await walkFiles(path.join(ws.dir, '.awe'))).filter(f => f.endsWith('.tmp') || f.includes('.stale-')).length, 0);
  assert.equal((await resume(ws)).reused, 12);
});

test('argv and credentials are never written into the cache; prompts are kept only as prompt files', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'PROMPT-MARKER-4242 OUTPUT::fine' }, { run: agentCommand(path.join(os.tmpdir(), 'unused.log'), ['--api-key=SUPERSECRET-9876']) });
  const state = await resume(ws);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.steps['1.1'].executor, 'run');
  const hits = [];
  for (const file of await walkFiles(path.join(ws.dir, '.awe'))) {
    const text = await readFile(file, 'utf8').catch(() => '');
    assert.ok(!text.includes('SUPERSECRET-9876'), `credential leaked into ${file}`);
    if (text.includes('PROMPT-MARKER-4242')) hits.push(path.basename(file));
  }
  assert.deepEqual(hits, ['prompt-1-1-attempt-1.md'], 'only the prompt file holds the prompt, never the session cache or state');
  assert.ok(state.steps['1.1'].prompt.endsWith('prompt-1-1-attempt-1.md'));
  const { data } = await sessionFile(ws.dir);
  assert.match(data.compat.input, /^[0-9a-f]{64}$/);
  assert.match(data.records['1.1'].latest.fingerprint, /^[0-9a-f]{64}$/);

  const optedOut = await workspace(t, { '1.1-a.md': 'PROMPT-MARKER-4242 OUTPUT::fine' }, { storePrompts: false });
  const quiet = await resume(optedOut);
  assert.equal(quiet.status, 'COMPLETED');
  assert.equal(quiet.steps['1.1'].prompt, undefined);
  for (const file of await walkFiles(path.join(optedOut.dir, '.awe'))) {
    assert.ok(!(await readFile(file, 'utf8').catch(() => '')).includes('PROMPT-MARKER-4242'), `prompt stored despite storePrompts:false: ${file}`);
  }
});

test('a command killed from outside AWE (OOM, kill -9) after acting is an unknown outcome, not a plain failure', posix, async t => {
  const ws = await workspace(t, { '1.1-act.md': 'APPEND::effects.log::effect\nSELF_KILL::' });
  const effects = async () => (await readFile(path.join(ws.dir, 'effects.log'), 'utf8')).trim().split('\n').length;
  const first = await resume(ws);
  assert.equal(first.error.code, 'EXECUTOR_FAILED');
  assert.match(first.error.message, /terminated by signal SIGKILL/);
  assert.equal(await effects(), 1);

  const second = await resume(ws);
  assert.equal(second.error.code, 'UNKNOWN_EFFECT', 'the second command must not resend it');
  assert.match(second.error.message, /--retry 1\.1/);
  assert.equal(await effects(), 1, 'the executor did not start again');

  const third = await resume(ws, ['--retry', '1.1']);
  assert.equal(third.error.code, 'EXECUTOR_FAILED');
  assert.equal(await effects(), 2, 'only the acknowledged retry ran');
  assert.equal((await resume(ws)).error.code, 'UNKNOWN_EFFECT', 'and it is unknown again');
});
