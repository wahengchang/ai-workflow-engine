import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Subprocess E2E: copies the real examples/ tree (docs, executor and workflows)
// into a temp dir so tests exercise exactly what ships.
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'awe.js');

async function examplesCopy(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-examples-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(root, 'examples'), dir, { recursive: true });
  return dir;
}

function awe(dir, args = [], cwd = dir) {
  return exec(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

function stateDir(base, dir) {
  return path.join(base, dir, '.awe', 'runs');
}

test('request-routing routes both branches and enforces the strict gate', async t => {
  const base = await examplesCopy(t);
  const say = path.join(base, 'executors', 'reply.cjs');
  const routing = path.join(base, 'request-routing', 'ENTRY.md');

  const plan = await awe(base, ['plan', routing]);
  assert.match(plan.stdout, /2\.1\.1/);
  assert.match(plan.stdout, /2\.1\.2/);

  const { stdout: defaultRun } = await awe(base, ['run', routing, '--json']);
  const approved = JSON.parse(defaultRun);
  assert.equal(approved.status, 'COMPLETED', JSON.stringify(approved.error));
  assert.ok(approved.steps['2.1.1']);
  assert.equal(approved.steps['2.1.2'], undefined);
  assert.equal(approved.executionMode, 'COMMAND');

  const { stdout: rejected } = await awe(base, ['run', routing, '--json',
    '--executor', 'command', '--command', process.execPath, '--arg', say, '--arg', '--say=REJECTED']);
  const rework = JSON.parse(rejected);
  assert.equal(rework.status, 'COMPLETED');
  assert.ok(rework.steps['2.1.2']);
  assert.ok(!rework.steps['2.1.1'], 'the approved branch must not have run');

  const dunno = await awe(base, ['run', routing, '--json',
    '--executor', 'command', '--command', process.execPath, '--arg', say, '--arg', '--say=DUNNO']).catch(error => error);
  assert.equal(dunno.code, 1);
  assert.match(dunno.stdout, /IF_NO_MATCH/);
  void stateDir;
});

test('bounded-review completes under the iteration bound and exhausts deterministically', async t => {
  const base = await examplesCopy(t);
  const say = path.join(base, 'executors', 'reply.cjs');
  const review = path.join(base, 'bounded-review', 'ENTRY.md');

  const { stdout } = await awe(base, ['run', review, '--json']);
  const completed = JSON.parse(stdout);
  assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.error));
  assert.equal(completed.steps['2.1.1'].attempts, 2);
  assert.ok(completed.events.some(e => e.type === 'LOOP_COMPLETED' && e.iteration === 2));
  assert.match(completed.steps['3.1'].outputPreview, /PASS/);

  // A rerun against the fresh counter behaves identically.
  await rm(path.join(base, 'bounded-review', '.demo-state'), { recursive: true, force: true });
  const { stdout: again } = await awe(base, ['run', review, '--json']);
  const againState = JSON.parse(again);
  assert.equal(againState.status, 'COMPLETED');
  assert.equal(againState.steps['2.1.1'].attempts, 2);

  const exhaust = await awe(base, ['run', review, '--json',
    '--executor', 'command', '--command', process.execPath, '--arg', say, '--arg', '--pass-on=99',
    '--arg', `--state=${path.join(base, 'bounded-review', '.demo-state', 'exhaust.txt')}`]).catch(error => error);
  assert.equal(exhaust.code, 1);
  assert.match(exhaust.stdout, /LOOP_EXHAUSTED/);
  assert.match(exhaust.stdout, /after 3 iterations/);
});

test('partial rerun: edit a downstream prompt, rerun from it, reuse the upstream five steps', async t => {
  const base = await examplesCopy(t);
  const generation = path.join(base, 'content-generation', 'ENTRY.md');
  const { stdout: first } = await awe(base, ['run', generation, '--json']);
  const source = JSON.parse(first);
  assert.equal(source.status, 'COMPLETED', JSON.stringify(source.error));
  const stateBefore = await readFile(path.join(base, 'content-generation', '.awe', 'runs', source.runId, 'state.json'));

  await writeFile(path.join(base, 'content-generation', 'stage-3', '3.2-deliver.md'),
    (await readFile(path.join(base, 'content-generation', 'stage-3', '3.2-deliver.md'), 'utf8')) + '\n\nDelivery note refreshed with this partial rerun.');
  const { stdout: second } = await awe(base, ['run', generation, '--json', '--from', '3.2', '--reuse', source.runId]);
  const partial = JSON.parse(second);
  assert.equal(partial.status, 'COMPLETED', JSON.stringify(partial.error));
  assert.deepEqual(partial.reusedSteps, ['1.1', '1.2', '2.1', '3.1.1', '3.1.2']);
  assert.equal(partial.parentRunId, source.runId);
  assert.equal(partial.steps['3.2'].reused, undefined);
  for (const id of partial.reusedSteps) {
    assert.equal(partial.steps[id].reused, true);
    assert.equal(await readFile(partial.steps[id].artifact, 'utf8'), await readFile(source.steps[id].artifact, 'utf8'));
  }
  assert.ok((await readFile(path.join(base, 'content-generation', '.awe', 'runs', source.runId, 'state.json'))).equals(stateBefore));
  const statusText = (await awe(base, ['status', partial.runId], path.join(base, 'content-generation'))).stdout;
  assert.match(statusText, /Partial: from 3\.2 of/);
});
