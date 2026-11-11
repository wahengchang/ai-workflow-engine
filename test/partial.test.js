import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../src/cli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const agent = path.join(root, 'test/fixtures/fake-agent.cjs');
const sayAgent = path.join(root, 'test/fixtures/say-agent.cjs');
const slowAgent = path.join(root, 'test/fixtures/slow-agent.cjs');
const devAgent = path.join(root, 'test/fixtures/dev-agent.cjs');
const agentCommand = { type: 'command', argv: [process.execPath, agent], timeoutMs: 5000 };

async function fixture(t, files, config = { executor: agentCommand }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-partial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'ENTRY.md': '# Instructions', 'awe.json': JSON.stringify(config), ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

function countRuns(dir) {
  return readdir(path.join(dir, '.awe', 'runs')).catch(() => []);
}

async function runJson(dir, args = []) {
  const result = await cli(['run', dir, '--json', ...args], root);
  const state = JSON.parse(result.output);
  return { result, state };
}

const sequenceFiles = {
  '1.1-analyze.md': 'OUTPUT::analyzed',
  '1.2-outline.md': 'OUTPUT::outline-{{ steps["1.1"].output }}',
  '2.1-draft.md': 'OUTPUT::draft-{{ steps["1.2"].output }}',
  '2.2-review.md': 'OUTPUT::review-{{ steps["2.1"].output }}',
  '3.1-deliver.md': 'OUTPUT::deliver-{{ steps["2.2"].output }}',
};

test('full runs record complete fingerprints and stay readable for legacy tools', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state } = await runJson(dir);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.equal(state.fingerprints.version, 1);
  assert.match(state.fingerprints.topology, /^[0-9a-f]{64}$/);
  assert.match(state.fingerprints.entry, /^[0-9a-f]{64}$/);
  assert.match(state.fingerprints.input, /^[0-9a-f]{64}$/);
  assert.match(state.fingerprints.prompts['1.1'], /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(state.fingerprints.prompts).length >= 5);
  for (const [id, record] of Object.entries(state.steps)) {
    assert.match(state.fingerprints.artifacts[id], /^[0-9a-f]{64}$/, `artifact hash for ${id}`);
    assert.equal(record.reused, undefined, 'full runs carry no reuse markers');
  }
  assert.match((await cli(['status', state.runId], dir)).output, /COMPLETED/);
  assert.equal(JSON.parse((await cli(['inspect', state.runId, '--step', '2.1'], dir)).output).source, '2.1-draft.md');
});

test('sequence partial rerun from 3.1 reuses upstream, executes the suffix, and downstream edits apply', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: source } = await runJson(dir);
  await writeFile(path.join(dir, '3.1-deliver.md'), 'OUTPUT::deliver-v2-{{ steps["2.2"].output }}');
  const before = await readFile(path.join(dir, '.awe', 'runs', source.runId, 'state.json'));

  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.deepEqual(state.reusedSteps, ['1.1', '1.2', '2.1', '2.2']);
  assert.equal(state.parentRunId, source.runId);
  assert.equal(state.from, '3.1');
  for (const id of state.reusedSteps) {
    assert.equal(state.steps[id].reused, true);
    assert.equal(state.steps[id].originRunId, source.runId);
    assert.equal(state.steps[id].attempts, source.steps[id].attempts);
    assert.equal(state.steps[id].attempts, 1);
  }
  assert.equal(state.steps['3.1'].reused, undefined);
  assert.equal(state.steps['3.1'].attempts, 1);
  assert.equal(await readFile(state.steps['3.1'].artifact, 'utf8'), 'deliver-v2-review-draft-outline-analyzed');
  for (const id of state.reusedSteps) {
    assert.equal(await readFile(state.steps[id].artifact, 'utf8'), await readFile(source.steps[id].artifact, 'utf8'));
    assert.ok(state.steps[id].artifact.startsWith(path.join(dir, '.awe', 'runs', state.runId, 'artifacts')));
  }
  assert.ok((await readFile(path.join(dir, '.awe', 'runs', source.runId, 'state.json'))).equals(before));
  const statusText = (await cli(['status', state.runId], dir)).output;
  assert.match(statusText, /Partial: from 3\.1 of/);
  assert.match(statusText, /\(reused 4 steps\)/);
  assert.equal(JSON.parse((await cli(['status', state.runId, '--json'], dir)).output).parentRunId, source.runId);
  assert.equal(JSON.parse((await cli(['inspect', state.runId, '--step', '1.1'], dir)).output).reused, true);
});

test('a cut before the last step executes every later step of the suffix', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: source } = await runJson(dir);
  const { state } = await runJson(dir, ['--from', '2.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '1.2']);
  assert.ok(state.steps['2.1'] && state.steps['2.2'] && state.steps['3.1']);
  for (const id of ['2.1', '2.2', '3.1']) assert.equal(state.steps[id].reused, undefined);
  assert.equal(await readFile(state.steps['2.1'].artifact, 'utf8'), 'draft-outline-analyzed');
  assert.equal(await readFile(state.steps['3.1'].artifact, 'utf8'), 'deliver-review-draft-outline-analyzed');
});

test('numbered sequence group ids are cuttable and sequence cells stay transparent', async t => {
  const dir = await fixture(t, {
    '1.1-start.md': 'OUTPUT::start',
    '2.1-group/2.1.1-a.md': 'OUTPUT::a {{ steps["1.1"].output }}',
    '2.1-group/2.1.2-b.md': 'OUTPUT::b',
    '3.1-end.md': 'OUTPUT::end {{ steps["2.1.2"].output }}',
  });
  const { state: source } = await runJson(dir);
  void source;
  const { state } = await runJson(dir, ['--from', '2.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1']);
  assert.deepEqual(Object.keys(state.steps).sort(), ['1.1', '2.1.1', '2.1.2', '3.1'].sort());
  // Prompt-level cut inside the numbered sequence: earlier group steps reuse.
  const { state: inner } = await runJson(dir, ['--from', '2.1.2', '--reuse', source.runId]);
  assert.deepEqual(inner.reusedSteps, ['1.1', '2.1.1']);
  assert.ok(inner.steps['2.1.2'] && inner.steps['3.1']);
});

test('artifact path references resolve to the new copies, never to source-run paths', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: source } = await runJson(dir);
  await writeFile(path.join(dir, '3.1-deliver.md'), 'OUTPUT::{{ steps["1.2"].artifact }}');
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  const delivered = await readFile(state.steps['3.1'].artifact, 'utf8').then(s => s.trim());
  assert.ok(delivered.startsWith(path.join(dir, '.awe', 'runs', state.runId, 'artifacts')) && delivered.endsWith('1-2-attempt-1.md'), delivered);
});

test('partial reruns are re-usable (partial of partial) and copy artifacts byte-identical', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: first } = await runJson(dir);
  await writeFile(path.join(dir, '2.2-review.md'), 'OUTPUT::review2-{{ steps["2.1"].output }}');
  const { state: second } = await runJson(dir, ['--from', '2.2', '--reuse', first.runId]);
  assert.equal(second.status, 'COMPLETED');
  assert.equal(second.parentRunId, first.runId);
  assert.deepEqual(second.reusedSteps, ['1.1', '1.2', '2.1']);
  const { state: third } = await runJson(dir, ['--from', '3.1', '--reuse', second.runId]);
  assert.equal(third.status, 'COMPLETED');
  assert.equal(third.parentRunId, second.runId);
  assert.deepEqual(third.reusedSteps, ['1.1', '1.2', '2.1', '2.2']);
  assert.equal(await readFile(third.steps['2.1'].artifact, 'utf8'), await readFile(first.steps['2.1'].artifact, 'utf8'));
  assert.deepEqual(third.inputSource.vars, first.inputSource.vars);
});

test('input variants carry over: --var original survives defaults checks', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: source } = await runJson(dir, ['--var', 'topic=custom-topic']);
  assert.equal(source.inputSource.vars.topic, 'custom-topic');
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.equal(state.status, 'COMPLETED');
  assert.deepEqual(state.input, source.input);
  assert.deepEqual(state.inputSource.vars, source.inputSource.vars);
  // Changing the defaults rejects; the carried vars cannot mask the drift.
  await writeFile(path.join(dir, 'awe.json'), JSON.stringify({ executor: agentCommand, input: { topic: 'changed' } }));
  await assert.rejects(
    () => runJson(dir, ['--from', '3.1', '--reuse', source.runId]),
    error => error.code === 'PARTIAL_INPUT_CHANGED',
  );
});

test('IF partial reruns reuse the chosen branch; a numbered-group cut re-executes the gate', async t => {
  const dir = await fixture(t, {
    '1.1-gate.md': 'OUTPUT::APPROVED',
    '2.1-route/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'APPROVED', elseEquals: 'REJECTED', then: 'approved', else: 'rework' }),
    '2.1-route/approved/2.1.1-publish.md': 'OUTPUT::published',
    '2.1-route/rework/2.1.2-rework.md': 'OUTPUT::reworked',
    '3.1-deliver.md': 'OUTPUT::delivered-{{ steps["1.1"].output }}',
  });
  const { state: source } = await runJson(dir);
  assert.equal(source.steps['2.1.1'].status, 'COMPLETED');
  assert.equal(source.steps['2.1.2'], undefined);
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '2.1.1'], 'only the chosen branch is reused');
  assert.equal(state.steps['2.1.2'], undefined, 'the untaken branch is never seeded');

  await assert.rejects(
    () => runJson(dir, ['--from', '2.1', '--reuse', source.runId, '--executor', 'echo']),
    error => error.code === 'PARTIAL_MODE_MISMATCH',
  );
  // A cut at the numbered IF group re-executes the whole gate against the
  // seeded upstream; the seeded test output is unchanged, so the same branch
  // runs fresh (never seeded, attempts reset).
  const { state: reranGate } = await runJson(dir, ['--from', '2.1', '--reuse', source.runId]);
  assert.equal(reranGate.status, 'COMPLETED');
  assert.deepEqual(reranGate.reusedSteps, ['1.1']);
  assert.equal(reranGate.steps['2.1.1'].reused, undefined);
  assert.equal(reranGate.steps['2.1.1'].attempts, 1);
  assert.equal(reranGate.steps['2.1.2'], undefined);

  // A source whose chosen branch was the else branch reuses the else steps.
  const other = await fixture(t, {
    '1.1-gate.md': 'OUTPUT::APPROVED',
    '2.1-route/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'APPROVED', elseEquals: 'REJECTED', then: 'approved', else: 'rework' }),
    '2.1-route/approved/2.1.1-publish.md': 'OUTPUT::published',
    '2.1-route/rework/2.1.2-rework.md': 'OUTPUT::reworked',
    '3.1-deliver.md': 'OUTPUT::delivered-{{ steps["1.1"].output }}',
  });
  const { state: elseSource } = await runJson(other, ['--executor', 'command', '--command', process.execPath, '--arg', sayAgent, '--arg', '--say=REJECTED']);
  assert.equal(elseSource.steps['2.1.2'].status, 'COMPLETED');
  const { state: elsePartial } = await runJson(other, ['--from', '3.1', '--reuse', elseSource.runId]);
  assert.deepEqual(elsePartial.reusedSteps, ['1.1', '2.1.2']);
});

test('no-match IF runs cannot seed downstream context but a cut at the gate reruns it', async t => {
  const dir = await fixture(t, {
    '1.1-gate.md': 'OUTPUT::APPROVED',
    '2.1-route/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'APPROVED', elseEquals: 'REJECTED', then: 'approved', else: 'rework' }),
    '2.1-route/approved/2.1.1-publish.md': 'OUTPUT::published',
    '2.1-route/rework/2.1.2-rework.md': 'OUTPUT::reworked',
    '3.1-deliver.md': 'OUTPUT::delivered-{{ steps["1.1"].output }}',
  });
  const flags = ['--executor', 'command', '--command', process.execPath, '--arg', sayAgent];
  const { state: failed } = await runJson(dir, [...flags, '--arg', '--say=DUNNO']);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error.code, 'IF_NO_MATCH');
  await assert.rejects(
    () => runJson(dir, ['--from', '3.1', '--reuse', failed.runId, ...flags, '--arg', '--say=APPROVED']),
    error => error.code === 'PARTIAL_SOURCE_INCOMPLETE',
  );
  // A cut at the gate is permitted (upstream 1.1 completed), but the seed is
  // the copied DUNNO verdict, so the deterministic gate fails again and the
  // rerun persists the reuse provenance with a FAILED terminal status.
  const { state: rerun } = await runJson(dir, ['--from', '2.1', '--reuse', failed.runId, ...flags, '--arg', '--say=APPROVED']);
  assert.equal(rerun.status, 'FAILED');
  assert.equal(rerun.error.code, 'IF_NO_MATCH');
  assert.deepEqual(rerun.reusedSteps, ['1.1']);
  assert.equal(rerun.steps['2.1.1'], undefined);
});

test('LOOP partial reruns seed final body attempts; exhausted loops are not reusable upstream', async t => {
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-a.md': 'OUTPUT::A',
    '1.1-loop/1.1.2-gate.md': 'OUTPUT::gate {{ steps["1.1.1"].output }}',
    '1.2-final.md': 'OUTPUT::final-{{ steps["1.1.1"].output }}',
  });
  const counter = dirPath => path.join(dirPath, 'loop-counter.txt');
  const say = (dirPath, on) => ['--executor', 'command', '--command', process.execPath, '--arg', sayAgent, '--arg', `--pass-on=${on}`, '--arg', `--state=${counter(dirPath)}`];
  const { state: source } = await runJson(dir, say(dir, 4)); // calls: a1,g1,a2,g2 → gate attempt 2 = PASS
  assert.equal(source.status, 'COMPLETED');
  assert.equal(source.steps['1.1.1'].attempts, 2);
  assert.equal(source.steps['1.1.2'].attempts, 2);
  const { state } = await runJson(dir, ['--from', '1.2', '--reuse', source.runId, ...say(dir, 99)]);
  assert.deepEqual(state.reusedSteps, ['1.1.1', '1.1.2']);
  assert.equal(state.steps['1.1.1'].attempts, 2, 'final loop attempts are seeded');
  assert.equal(state.steps['1.2'].reused, undefined);
  assert.equal(await readFile(state.steps['1.1.2'].artifact, 'utf8'), 'PASS');

  const exhausted = await fixture(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 1 }),
    '1.1-loop/1.1.1-gate.md': 'OUTPUT::gate',
    '1.2-final.md': 'OUTPUT::final-{{ steps["1.1.1"].output }}',
  });
  const { state: failedRun } = await runJson(exhausted, say(exhausted, 99));
  assert.equal(failedRun.status, 'FAILED');
  assert.equal(failedRun.error.code, 'LOOP_EXHAUSTED');
  await assert.rejects(
    () => runJson(exhausted, ['--from', '1.2', '--reuse', failedRun.runId, ...say(exhausted, 99)]),
    error => error.code === 'PARTIAL_SOURCE_INCOMPLETE',
  );
  await assert.rejects(
    () => runJson(exhausted, ['--from', '9.9', '--reuse', failedRun.runId]),
    error => error.code === 'PARTIAL_INVALID_CUT',
  );
  await rm(counter(exhausted), { force: true });
  const { state: reranLoop } = await runJson(exhausted, ['--from', '1.1', '--reuse', failedRun.runId, ...say(exhausted, 1)]);
  assert.equal(reranLoop.status, 'COMPLETED');
  assert.deepEqual(reranLoop.reusedSteps, []);
});

test('a LOOP containing an IF seeds the taken branch attempts only', async t => {
  const dir = await fixture(t, {
    '1.1-token.md': 'OUTPUT::token',
    '1.2-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.2.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.2-loop/1.2.1-branch/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'token', then: 'keep', else: 'swap' }),
    '1.2-loop/1.2.1-branch/keep/1.2.1.1-a.md': 'OUTPUT::A',
    '1.2-loop/1.2.1-branch/swap/1.2.1.2-b.md': 'OUTPUT::B',
    '1.2-loop/1.2.2-gate.md': 'RETRY_ONCE {{ steps["1.1"].output }}',
    '1.3-final.md': 'OUTPUT::final-{{ steps["1.2.2"].output }}',
  });
  const { state: source } = await runJson(dir);
  assert.equal(source.status, 'COMPLETED');
  assert.ok(source.steps['1.2.1.1'].attempts >= 1);
  assert.equal(source.steps['1.2.1.2'], undefined, 'static preflight rejects the untaken reference');
  const { state } = await runJson(dir, ['--from', '1.3', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '1.2.1.1', '1.2.2']);
  assert.equal(state.steps['1.2.1.2'], undefined);
  assert.equal(state.steps['1.2.1.1'].attempts, source.steps['1.2.1.1'].attempts);
});

test('a PARALLEL group containing an IF reuses the joined chosen branches', async t => {
  const dir = await fixture(t, {
    '1.1-token.md': 'OUTPUT::token',
    '2.1-checks/FLOW.json': JSON.stringify({ type: 'parallel' }),
    '2.1-checks/2.1.1-facts.md': 'OUTPUT::facts',
    '2.1-checks/2.1.2-route/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'token', then: 'keep', else: 'swap' }),
    '2.1-checks/2.1.2-route/keep/2.1.2.1-a.md': 'OUTPUT::A',
    '2.1-checks/2.1.2-route/swap/2.1.2.2-b.md': 'OUTPUT::B',
    '3.1-deliver.md': 'OUTPUT::deliver-{{ steps["2.1.1"].output }}',
  });
  const { state: source } = await runJson(dir);
  assert.equal(source.status, 'COMPLETED');
  assert.equal(source.steps['2.1.2.1'].status, 'COMPLETED');
  assert.equal(source.steps['2.1.2.2'], undefined);
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '2.1.1', '2.1.2.1']);
  assert.equal(state.steps['2.1.2.2'], undefined);
});

test('PARALLEL groups reuse joined artifacts and cuts never enter the group', async t => {
  const dir = await fixture(t, {
    '1.1-draft.md': 'OUTPUT::draft',
    '2.1-checks/FLOW.json': JSON.stringify({ type: 'parallel' }),
    '2.1-checks/2.1.1-facts.md': 'OUTPUT::facts',
    '2.1-checks/2.1.2-editorial.md': 'OUTPUT::editorial',
    '3.1-deliver.md': 'OUTPUT::deliver-{{ steps["2.1.1"].output }}',
  });
  const { state: source } = await runJson(dir);
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '2.1.1', '2.1.2']);
  assert.equal(state.steps['2.1.2'].attempts, 1);
  await assert.rejects(
    () => runJson(dir, ['--from', '2.1.2', '--reuse', source.runId]),
    error => error.code === 'PARTIAL_INVALID_CUT',
  );
  const { state: reranGroup } = await runJson(dir, ['--from', '2.1', '--reuse', source.runId]);
  assert.deepEqual(reranGroup.reusedSteps, ['1.1']);
  assert.equal(reranGroup.steps['2.1.1'].reused, undefined);
  assert.equal(reranGroup.steps['2.1.1'].attempts, 1);
});

async function expectReject(t, dir, args, code) {
  const runsBefore = (await countRuns(dir)).length;
  await assert.rejects(
    () => cli(['run', dir, '--json', ...args], root),
    error => error.code === code,
  );
  assert.equal((await countRuns(dir)).length, runsBefore, 'a rejected partial must not create a run directory');
}

test('flag pairing and gate rejections happen before any run directory is created', async t => {
  const dir = await fixture(t, sequenceFiles);
  await assert.rejects(() => cli(['run', dir, '--from', '2.1'], root), error => error.code === 'CLI_USAGE');
  await assert.rejects(() => cli(['run', dir, '--reuse', 'x'], root), error => error.code === 'CLI_USAGE');
  for (const command of ['validate', 'plan', 'simulate', 'explain', 'status']) {
    await assert.rejects(() => cli([command, dir, '--from', '2.1', '--reuse', 'x'], root), error => error.code === 'CLI_USAGE');
  }
  await assert.rejects(() => cli(['init', '--out', path.join(dir, 'x'), '--from', '2.1'], root), error => error.code === 'CLI_USAGE');
  const { state } = await runJson(dir);
  await expectReject(t, dir, ['--from', '2.1', '--reuse', state.runId, '--var', 'topic=x'], 'PARTIAL_VAR_REJECTED');
  await expectReject(t, dir, ['--from', '9.9', '--reuse', state.runId], 'PARTIAL_INVALID_CUT');
  await expectReject(t, dir, ['--from', '2.1', '--reuse', 'no-such-run'], 'PARTIAL_SOURCE_NOT_FOUND');
  await expectReject(t, dir, ['--from', '2.1', '--reuse', state.runId, '--executor', 'echo'], 'PARTIAL_MODE_MISMATCH');
});

test('guard rejections: legacy source, running source, altered artifacts and texts', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state } = await runJson(dir);
  const runDir = path.join(dir, '.awe', 'runs', state.runId);
  const statePath = path.join(runDir, 'state.json');
  const original = await readFile(statePath, 'utf8');

  const legacy = JSON.parse(original);
  delete legacy.fingerprints;
  await writeFile(statePath, JSON.stringify(legacy, null, 2));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_LEGACY_SOURCE');

  const legacyPartial = JSON.parse(original);
  legacyPartial.parentRunId = 'x';
  legacyPartial.from = '1.1';
  await writeFile(statePath, JSON.stringify(legacyPartial, null, 2));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_LEGACY_SOURCE');

  const running = JSON.parse(original);
  running.status = 'RUNNING';
  await writeFile(statePath, JSON.stringify(running, null, 2));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_SOURCE_RUNNING');

  const cancelled = JSON.parse(original);
  cancelled.status = 'CANCELLED';
  await writeFile(statePath, JSON.stringify(cancelled, null, 2));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_SOURCE_RUNNING');

  await writeFile(statePath, original);
  const artifact21 = await readFile(path.join(runDir, 'artifacts', '2-1-attempt-1.md'));
  const artifact11 = await readFile(path.join(runDir, 'artifacts', '1-1-attempt-1.md'));
  await writeFile(path.join(runDir, 'artifacts', '2-1-attempt-1.md'), 'TAMPERED');
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_ARTIFACT_CHANGED');
  await writeFile(path.join(runDir, 'artifacts', '2-1-attempt-1.md'), artifact21);
  await rm(path.join(runDir, 'artifacts', '1-1-attempt-1.md'));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_ARTIFACT_MISSING');
  await writeFile(path.join(runDir, 'artifacts', '1-1-attempt-1.md'), artifact11);

  await writeFile(path.join(dir, '1.1-analyze.md'), 'OUTPUT::analyzed-CHANGED');
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_UPSTREAM_PROMPT_CHANGED');
  await writeFile(path.join(dir, '1.1-analyze.md'), 'OUTPUT::analyzed');

  await writeFile(path.join(dir, 'ENTRY.md'), '# Changed instructions');
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_ENTRY_CHANGED');
  await writeFile(path.join(dir, 'ENTRY.md'), '# Instructions');

  const configPath = path.join(dir, 'awe.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(configPath, JSON.stringify({ ...config, input: { topic: 'changed' } }));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_INPUT_CHANGED');
  await writeFile(configPath, JSON.stringify(config));

  // Tampered state identity (state.runId not matching the requested run) is rejected.
  const forged = JSON.parse(original);
  forged.runId = 'other-identity';
  await writeFile(statePath, JSON.stringify(forged, null, 2));
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_LEGACY_SOURCE');
  await writeFile(statePath, original);

  // Downstream edits remain accepted once everything upstream is intact again.
  await writeFile(path.join(dir, '3.1-deliver.md'), 'OUTPUT::UNIQUE-DOWNSTREAM-{{ steps["2.2"].output }}');
  const { state: partialRun } = await runJson(dir, ['--from', '3.1', '--reuse', state.runId]);
  assert.equal(partialRun.status, 'COMPLETED');
  assert.match(partialRun.fingerprints.prompts['3.1'], /^[0-9a-f]{64}$/);
});

test('control config and topology changes are rejected pre-run; foreign-workflow runs are rejected', async t => {
  const loopFiles = {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 2 }),
    '1.1-loop/1.1.1-gate.md': 'OUTPUT::PASS',
    '1.2-final.md': 'OUTPUT::final-{{ steps["1.1.1"].output }}',
  };
  const dir = await fixture(t, loopFiles);
  const { state } = await runJson(dir);
  await writeFile(path.join(dir, '1.1-loop', 'FLOW.json'), JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 99 }));
  await expectReject(t, dir, ['--from', '1.2', '--reuse', state.runId], 'PARTIAL_TOPOLOGY_MISMATCH');
  await writeFile(path.join(dir, '1.1-loop', 'FLOW.json'), loopFiles['1.1-loop/FLOW.json']);
  const otherDir = await fixture(t, loopFiles);
  const { state: other } = await runJson(otherDir);
  const dest = path.join(dir, '.awe', 'runs', other.runId);
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, 'state.json'), await readFile(path.join(otherDir, '.awe', 'runs', other.runId, 'state.json'), 'utf8'));
  await expectReject(t, dir, ['--from', '1.2', '--reuse', other.runId], 'PARTIAL_WORKFLOW_MISMATCH');
});

test('symlinked artifacts escape the source run and are rejected before reuse', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state } = await runJson(dir);
  const runDir = path.join(dir, '.awe', 'runs', state.runId);
  const outside = path.join(dir, '.outside-storage');
  await mkdir(outside, { recursive: true });
  // Back up exact artifact bytes before tampering so both phases use real runs.
  const backup = {};
  for (const [id, record] of Object.entries(state.steps)) {
    const name = `${id.replaceAll('.', '-')}-attempt-${record.attempts}.md`;
    backup[name] = await readFile(record.artifact);
  }
  await writeFile(path.join(outside, 'escape.md'), 'ESCAPED');

  // Phase 1: the artifacts directory becomes a symlink to storage outside the run.
  await rm(path.join(runDir, 'artifacts'), { recursive: true, force: true });
  await symlink(outside, path.join(runDir, 'artifacts'), 'dir');
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_ARTIFACT_MISSING');
  await rm(path.join(runDir, 'artifacts'), { force: true });

  // Phase 2: intact artifacts restored, one file replaced by a symlink pointing outside.
  await mkdir(path.join(runDir, 'artifacts'), { recursive: true });
  for (const [name, bytes] of Object.entries(backup)) {
    await writeFile(path.join(runDir, 'artifacts', name), bytes);
  }
  await rm(path.join(runDir, 'artifacts', '2-1-attempt-1.md'), { force: true });
  await symlink(path.join(outside, 'escape.md'), path.join(runDir, 'artifacts', '2-1-attempt-1.md'), 'file');
  await expectReject(t, dir, ['--from', '3.1', '--reuse', state.runId], 'PARTIAL_ARTIFACT_MISSING');
  // Killing the symlink and restoring the original bytes makes reuse valid again.
  await rm(path.join(runDir, 'artifacts', '2-1-attempt-1.md'), { force: true });
  await writeFile(path.join(runDir, 'artifacts', '2-1-attempt-1.md'), backup['2-1-attempt-1.md']);
  const { state: recovered } = await runJson(dir, ['--from', '3.1', '--reuse', state.runId]);
  assert.equal(recovered.status, 'COMPLETED');
});

test('declared output files are copied on reuse and verified before seeding', async t => {
  const dir = await fixture(t, {
    '1.1-generate.md': 'WRITE::out/report.txt::hello-report\nOUTPUT::generated',
    '1.2-final.md': 'OUTPUT::final-{{ steps["1.1"].files["report"] }}',
  }, {
    executor: { type: 'command', argv: [process.execPath, devAgent], timeoutMs: 5000 },
    steps: { '1.1': { outputs: [{ name: 'report', path: 'out/report.txt' }] } },
  });
  const { state: source } = await runJson(dir);
  assert.equal(source.status, 'COMPLETED', JSON.stringify(source.error));
  const saved = source.steps['1.1'].files.report;
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(saved.path, 'utf8'), 'hello-report');
  assert.equal(source.fingerprints.files['1.1'].report, saved.sha256);

  const { state } = await runJson(dir, ['--from', '1.2', '--reuse', source.runId]);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.deepEqual(state.reusedSteps, ['1.1']);
  assert.equal(state.steps['1.1'].reused, true);
  const copy = state.steps['1.1'].files.report;
  assert.ok(copy.path.startsWith(path.join(dir, '.awe', 'runs', state.runId, 'artifacts', 'files')), copy.path);
  assert.notEqual(copy.path, saved.path);
  assert.equal(await readFile(copy.path, 'utf8'), 'hello-report');
  const rendered = await readFile(state.steps['1.2'].artifact, 'utf8');
  assert.ok(rendered.includes(copy.path), 'the executed suffix sees the new run copy');
  assert.ok(!rendered.includes(saved.path), 'never the source-run path');

  // The source copy is fingerprinted, so tampering is rejected before a run exists.
  await chmod(saved.path, 0o644);
  await writeFile(saved.path, 'TAMPERED');
  await expectReject(t, dir, ['--from', '1.2', '--reuse', source.runId], 'PARTIAL_ARTIFACT_CHANGED');
});

test('partial reruns accept another path spelling of the same workflow', async t => {
  const dir = await fixture(t, sequenceFiles);
  const alias = path.join(path.dirname(dir), `${path.basename(dir)}-alias`);
  await symlink(dir, alias, 'dir');
  t.after(() => rm(alias, { force: true }));
  // The source run records artifacts under the alias spelling; the rerun is
  // invoked through the real path (as /tmp vs /private/tmp does on macOS).
  const { state: source } = await runJson(alias);
  assert.equal(source.status, 'COMPLETED', JSON.stringify(source.error));
  assert.ok(source.steps['1.1'].artifact.startsWith(alias), source.steps['1.1'].artifact);
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.deepEqual(state.reusedSteps, ['1.1', '1.2', '2.1', '2.2']);
  assert.equal(await readFile(state.steps['3.1'].artifact, 'utf8'), 'deliver-review-draft-outline-analyzed');
});

test('a populated artifacts directory moved outside the run is rejected before any side effect', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state } = await runJson(dir);
  const runDir = path.join(dir, '.awe', 'runs', state.runId);
  const sourceStatePath = path.join(runDir, 'state.json');
  const runsBefore = (await countRuns(dir)).length;
  const beforeState = await readFile(sourceStatePath);
  const counter = path.join(dir, 'partial-executor-calls.txt');
  // Same execution mode as the source; --pass-on writes a call counter, so any
  // executor launch would leave a file behind.
  const attempt = () => cli(['run', dir, '--json', '--from', '3.1', '--reuse', state.runId,
    '--executor', 'command', '--command', process.execPath,
    '--arg', sayAgent, '--arg', '--pass-on=90', '--arg', `--state=${counter}`], root);
  const assertNoSideEffects = async () => {
    assert.equal((await countRuns(dir)).length, runsBefore, 'a rejected partial must not create a run directory');
    await assert.rejects(() => readFile(counter), { code: 'ENOENT' }, 'a rejected partial must not reach the executor');
    assert.ok((await readFile(sourceStatePath)).equals(beforeState), 'the source run state must stay byte-identical');
  };

  // Phase 1: the complete, populated artifacts directory lives outside the run
  // and is symlinked back. Realpath on both sides agrees, so containment must
  // come from proving the directory chain itself.
  const movedArtifacts = path.join(dir, '.moved-artifacts');
  await rename(path.join(runDir, 'artifacts'), movedArtifacts);
  await symlink(movedArtifacts, path.join(runDir, 'artifacts'), 'dir');
  assert.ok((await readdir(movedArtifacts)).length >= 5, 'the external directory really holds the original artifacts');
  await assert.rejects(attempt, error => error.code === 'PARTIAL_ARTIFACT_MISSING');
  await assertNoSideEffects();

  // Restoring the real directory makes the same reuse valid again.
  await rm(path.join(runDir, 'artifacts'), { force: true });
  await rename(movedArtifacts, path.join(runDir, 'artifacts'));
  const { state: recovered } = await runJson(dir, ['--from', '3.1', '--reuse', state.runId]);
  assert.equal(recovered.status, 'COMPLETED');

  // Phase 2: the whole run directory lives outside and is symlinked back.
  const movedRun = path.join(dir, '.moved-run');
  await rename(runDir, movedRun);
  await symlink(movedRun, runDir, 'dir');
  await assert.rejects(attempt, error => error.code === 'PARTIAL_ARTIFACT_MISSING');
  // The recovered run above is the newest entry; a rejection adds nothing.
  const runsAtPhase2 = (await countRuns(dir)).length;
  assert.equal(runsAtPhase2, runsBefore + 1, 'only the successful recovery created a run');
  await assert.rejects(() => readFile(counter), { code: 'ENOENT' }, 'the symlinked run directory never reaches the executor');
  assert.ok((await readFile(path.join(movedRun, 'state.json'))).equals(beforeState), 'the moved source run state is untouched');
  await rm(runDir, { force: true });
  await rename(movedRun, runDir);
  const { state: afterRestore } = await runJson(dir, ['--from', '3.1', '--reuse', state.runId]);
  assert.equal(afterRestore.status, 'COMPLETED');
});

test('nested IF inside a chosen branch seeds only the innermost taken path', async t => {
  const dir = await fixture(t, {
    '1.1-token.md': 'OUTPUT::token',
    '2.1-outer/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'token', then: 'keep', else: 'swap' }),
    '2.1-outer/keep/2.1.1-inner/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'token', then: 'yes', else: 'no' }),
    '2.1-outer/keep/2.1.1-inner/yes/2.1.1.1-a.md': 'OUTPUT::A',
    '2.1-outer/keep/2.1.1-inner/no/2.1.1.2-b.md': 'OUTPUT::B',
    '2.1-outer/swap/2.1.2-c.md': 'OUTPUT::C',
    '3.1-final.md': 'OUTPUT::final',
  });
  const { state: source } = await runJson(dir);
  assert.equal(source.status, 'COMPLETED', JSON.stringify(source.error));
  assert.equal(source.steps['2.1.1.2'], undefined, 'the inner untaken branch never runs');
  const { state } = await runJson(dir, ['--from', '3.1', '--reuse', source.runId]);
  assert.deepEqual(state.reusedSteps, ['1.1', '2.1.1.1'], 'only the innermost taken path is seeded');
  assert.equal(state.steps['2.1.1.2'], undefined);
  assert.equal(state.steps['2.1.2'], undefined);
});

test('LOOP reuse follows the final iteration branch and excludes stale earlier branches', async t => {
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-gate.md': 'OUTPUT::gate',
    '1.1-loop/1.1.2-route/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1.1"].output }}', equals: 'PASS', then: 'done', else: 'wait' }),
    '1.1-loop/1.1.2-route/done/1.1.2.1-ok.md': 'OUTPUT::ok',
    '1.1-loop/1.1.2-route/wait/1.1.2.2-wait.md': 'OUTPUT::wait',
    '1.2-final.md': 'OUTPUT::final-{{ steps["1.1.1"].output }}',
  }, { executor: { type: 'echo' } });
  // pass-on=2: iteration 1 gate PENDING then the IF takes "wait"; iteration 2
  // gate PASS then the IF takes "done" and the loop exits. The source therefore
  // records both branches, but only the final iteration's branch is reusable.
  const flags = ['--executor', 'command', '--command', process.execPath,
    '--arg', sayAgent, '--arg', '--pass-on=2', '--arg', `--state=${path.join(dir, 'executor-state.txt')}`];
  const { state: source } = await runJson(dir, flags);
  assert.equal(source.status, 'COMPLETED', JSON.stringify(source.error));
  assert.equal(source.steps['1.1.2.2'].status, 'COMPLETED', 'iteration 1 took the wait branch');
  assert.equal(source.steps['1.1.2.1'].status, 'COMPLETED', 'iteration 2 took the done branch');
  assert.equal(source.steps['1.1.1'].attempts, 2);

  const { state } = await runJson(dir, ['--from', '1.2', '--reuse', source.runId, ...flags]);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.deepEqual(state.reusedSteps, ['1.1.1', '1.1.2.1'], 'only the final iteration path is seeded');
  assert.equal(state.steps['1.1.2.2'], undefined, 'the earlier iteration branch is never seeded');
  assert.equal(state.steps['1.1.2.1'].reused, true);
  assert.equal(state.steps['1.1.1'].attempts, 2);
  assert.equal(await readFile(state.steps['1.1.1'].artifact, 'utf8'), 'PASS');
  assert.equal(await readFile(state.steps['1.1.2.1'].artifact, 'utf8'), 'PASS');
  assert.equal(state.steps['1.2'].reused, undefined);
});

test('interrupted partial reruns persist reused provenance with a terminal status (pre-abort)', async t => {
  const dir = await fixture(t, sequenceFiles);
  const { state: source } = await runJson(dir);
  const controller = new AbortController();
  controller.abort();
  const result = await cli(['run', dir, '--from', '2.1', '--reuse', source.runId, '--json'], root, { signal: controller.signal });
  const state = JSON.parse(result.output);
  assert.equal(state.status, 'INTERRUPTED');
  assert.deepEqual(state.reusedSteps, ['1.1', '1.2']);
  assert.equal(state.parentRunId, source.runId);
  assert.equal(state.steps['1.1'].reused, true);
  assert.equal(state.steps['2.1'], undefined, 'no suffix step may have started');
  assert.match((await cli(['status', state.runId], dir)).output, /INTERRUPTED/);
});

test('mid-run cancellation keeps reused provenance and terminal INTERRUPTED state', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t, sequenceFiles, {
    executor: { type: 'command', argv: [process.execPath, slowAgent, '400'], timeoutMs: 5000 },
  });
  const { state: source } = await runJson(dir);
  const controller = new AbortController();
  const runPromise = cli(['run', dir, '--from', '2.1', '--reuse', source.runId, '--json'], root, { signal: controller.signal });
  setTimeout(() => controller.abort('SIGINT'), 120);
  const interrupted = JSON.parse((await runPromise).output);
  assert.equal(interrupted.status, 'INTERRUPTED', JSON.stringify(interrupted.error));
  assert.deepEqual(interrupted.reusedSteps, ['1.1', '1.2']);
  assert.equal(interrupted.steps['1.1'].reused, true);
  assert.equal(interrupted.steps['2.1'].status, 'INTERRUPTED');
  assert.match((await cli(['status', interrupted.runId], dir)).output, /Partial: from 2\.1 of/);
  // The source run is untouched by the interrupted rerun.
  const sourceReloaded = JSON.parse((await cli(['status', source.runId, '--json'], dir)).output);
  assert.equal(sourceReloaded.status, 'COMPLETED');
});
