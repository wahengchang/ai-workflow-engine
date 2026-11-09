import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, put, dev, calls, countByStep, flow, agentArgs } from '../fixtures/dev-helpers.mjs';
import { cli } from '../src/cli.js';
import { precontext } from '../src/dev.js';

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `1.${from + i}`);

test('100 steps: --step runs 1-49 once, retests 50 three times, then dev . finishes 51-100 without rerunning 50', async t => {
  const files = {};
  for (let n = 1; n <= 100; n++) {
    files[`1.${n}-step.md`] = `${n === 1 ? 'start' : `Prev={{ steps["1.${n - 1}"].output }}`}\nOUTPUT::s${n}#{n}`;
  }
  const ws = await workspace(t, files);

  const first = await dev(ws, ['--step', '1.50']);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.dev.stoppedAfter, '1.50');
  assert.deepEqual([first.dev.executed, first.dev.reused], [50, 0]);
  const afterFirst = await countByStep(ws.log);
  assert.deepEqual(Object.keys(afterFirst), ids(1, 50), 'only 1-50 ran; nothing after the target');
  assert.ok(Object.values(afterFirst).every(count => count === 1));

  const upstreamDigests = [first.invocations.find(i => i.step === '1.50').upstreamDigest];
  for (const version of ['v2', 'v3']) {
    await put(ws.dir, '1.50-step.md', `Prev={{ steps["1.49"].output }}\nOUTPUT::s50-${version}#{n}`);
    const rerun = await dev(ws, ['--step', '1.50']);
    assert.equal(rerun.status, 'COMPLETED');
    assert.equal(rerun.dev.sessionId, first.dev.sessionId);
    assert.deepEqual([rerun.dev.executed, rerun.dev.reused], [1, 49]);
    upstreamDigests.push(rerun.invocations.find(i => i.step === '1.50' && i.action === 'EXECUTED').upstreamDigest);
  }
  assert.equal(new Set(upstreamDigests).size, 1, 'upstream context of step 50 is identical across the three tests');
  const afterThree = await countByStep(ws.log);
  assert.equal(afterThree['1.50'], 3);
  for (const id of ids(1, 49)) assert.equal(afterThree[id], 1, `${id} must not be called again`);

  const last = await dev(ws);
  assert.equal(last.status, 'COMPLETED');
  assert.deepEqual([last.dev.executed, last.dev.reused], [50, 50]);
  const final = await countByStep(ws.log);
  assert.equal(final['1.50'], 3, '50 is not rerun by dev .');
  for (const id of ids(51, 100)) assert.equal(final[id], 1);
  const call51 = (await calls(ws.log)).find(c => c.step === '1.51');
  assert.match(call51.prompt, /Prev=s50-v3#3\n/, 'step 51 consumes the latest successful result of step 50');
  const reused50 = last.invocations.find(i => i.step === '1.50');
  assert.equal(reused50.action, 'REUSED');
  assert.equal(reused50.from.attempt, 1);
});

test('editing an upstream prompt reruns it and everything after, but keeps earlier work', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::a#{n}',
    '1.2-b.md': 'A={{ steps["1.1"].output }} OUTPUT::b#{n}',
    '1.3-c.md': 'B={{ steps["1.2"].output }} OUTPUT::c#{n}',
  });
  await dev(ws);
  await put(ws.dir, '1.2-b.md', 'A={{ steps["1.1"].output }} OUTPUT::b-edited#{n}');
  const second = await dev(ws);
  assert.deepEqual([second.dev.executed, second.dev.reused], [2, 1]);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2': 2, '1.3': 2 });
  assert.match((await calls(ws.log)).filter(c => c.step === '1.3').at(-1).prompt, /B=b-edited#2/);
});

test('rerunning a step with identical output still invalidates later steps (causal, not by value)', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::same',
    '1.2-b.md': 'A={{ steps["1.1"].output }} OUTPUT::b#{n}',
  });
  await dev(ws);
  await dev(ws, ['--step', '1.1']);
  const next = await dev(ws);
  assert.deepEqual([next.dev.executed, next.dev.reused], [1, 1]);
  assert.equal((await countByStep(ws.log))['1.2'], 2);
});

test('a failed rerun blocks downstream from silently using the previous success', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::a',
    '1.2-b.md': 'FAIL_IF_EXISTS::block.flag\nOUTPUT::b#{n}',
    '1.3-c.md': 'B={{ steps["1.2"].output }} OUTPUT::c#{n}',
  });
  assert.equal((await dev(ws)).status, 'COMPLETED');
  await put(ws.dir, 'block.flag', 'x');

  const failed = await dev(ws, ['--step', '1.2']);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error.code, 'EXECUTOR_FAILED');

  const blocked = await dev(ws);
  assert.equal(blocked.status, 'FAILED', 'dev . must not fall back to the old success of 1.2');
  assert.equal(blocked.invocations.some(i => i.step === '1.3'), false, 'step 1.3 is not run or reused');
  const viaDownstream = await dev(ws, ['--step', '1.3']);
  assert.equal(viaDownstream.status, 'FAILED');
  assert.equal((await countByStep(ws.log))['1.3'], 1, '1.3 never ran again');

  await rm(path.join(ws.dir, 'block.flag'));
  const recovered = await dev(ws);
  assert.equal(recovered.status, 'COMPLETED');
  assert.deepEqual([recovered.dev.executed, recovered.dev.reused], [2, 1]);
  assert.match((await calls(ws.log)).filter(c => c.step === '1.3').at(-1).prompt, /B=b#5/);
});

test('IF branch flip: the gate re-evaluates, the other branch runs, the old branch is not forced', async t => {
  const ws = await workspace(t, {
    'verdict.txt': 'PASS',
    '1.1-judge.md': 'OUTPUT_FROM::verdict.txt',
    '1.2-route/FLOW.json': flow({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'PASS', then: 'approved', else: 'rework' }),
    '1.2-route/approved/1.2.1-ship.md': 'OUTPUT::ship#{n}',
    '1.2-route/rework/1.2.2-fix.md': 'OUTPUT::fix#{n}',
    '1.3-after.md': 'OUTPUT::after#{n}',
  });
  await dev(ws);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.3': 1 });

  await put(ws.dir, 'verdict.txt', 'FAIL');
  const stillOld = await dev(ws, ['--step', '1.2.1']);
  assert.equal(stillOld.status, 'COMPLETED', 'the judge result is reused, so the gate still selects the old branch');

  await dev(ws, ['--step', '1.1']);
  const refused = await dev(ws, ['--step', '1.2.1']);
  assert.equal(refused.status, 'FAILED');
  assert.equal(refused.error.code, 'TARGET_UNREACHABLE');
  assert.equal((await countByStep(ws.log))['1.2.1'], 2, 'the unselected branch was not executed');

  const flipped = await dev(ws);
  assert.equal(flipped.status, 'COMPLETED');
  assert.deepEqual(flipped.events.filter(e => e.type === 'IF_BRANCH').map(e => e.branch), ['rework']);
  const counts = await countByStep(ws.log);
  assert.equal(counts['1.2.2'], 1);
  assert.equal(counts['1.3'], 2, 'the step after the IF depends on the new branch');
});

// Outer loop (max 3) around: a, an inner loop (max 3) of b + gate g, and the outer gate og.
// A fresh run produces b#1 (O1,I1), b#2 (O1,I2), b#3 (O2,I1), b#4 (O3,I1).
const nestedLoop = {
  '1.1-outer/FLOW.json': flow({ type: 'loop', until: '{{ steps["1.1.3"].output }}', equals: 'PASS', maxIterations: 3 }),
  '1.1-outer/1.1.1-a.md': 'OUTPUT::a#{n}',
  '1.1-outer/1.1.2-inner/FLOW.json': flow({ type: 'loop', until: '{{ steps["1.1.2.2"].output }}', equals: 'PASS', maxIterations: 3 }),
  '1.1-outer/1.1.2-inner/1.1.2.1-b.md': 'OUTPUT::b#{n}',
  '1.1-outer/1.1.2-inner/1.1.2.2-g.md': 'PASS_IF_NUM_GTE::2::{{ steps["1.1.2.1"].output }}',
  '1.1-outer/1.1.3-og.md': 'PASS_IF_NUM_GTE::4::{{ steps["1.1.2.1"].output }}',
  '1.2-final.md': 'OUTPUT::final#{n}',
};
const occurrence = (outer, inner) => `1.1.2.1@1.1-outer=${outer},1.1-outer/1.1.2-inner=${inner}`;
const invocationOf = (outer, inner) => `1.1-outer=${outer},1.1-outer/1.1.2-inner=${inner}`;

test('nested LOOP: occurrences are addressed separately from attempts', async t => {
  const ws = await workspace(t, nestedLoop);
  const state = await dev(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const b = state.invocations.filter(i => i.step === '1.1.2.1');
  assert.deepEqual(b.map(i => i.address), [occurrence(1, 1), occurrence(1, 2), occurrence(2, 1), occurrence(3, 1)]);
  assert.deepEqual(b.map(i => i.attempt), [1, 2, 3, 4], 'one attempt per execution');
  assert.equal(state.steps['1.1.2.1'].attempts, 4);

  await assert.rejects(dev(ws, ['--step', '1.1.2.1']), error => {
    assert.equal(error.code, 'INVOCATION_REQUIRED');
    for (const [o, i] of [[1, 1], [1, 2], [2, 1], [3, 1]]) assert.ok(error.message.includes(invocationOf(o, i)), `lists ${invocationOf(o, i)}`);
    return true;
  });
  await assert.rejects(dev(ws, ['--step', '1.1.2.1', '--invocation', 'nonsense']), { code: 'INVOCATION_INVALID' });
  await assert.rejects(dev(ws, ['--step', '1.1.2.1', '--invocation', '1.1-outer=9,1.1-outer/1.1.2-inner=1']), { code: 'INVOCATION_INVALID' });
  await assert.rejects(dev(ws, ['--step', '1.2', '--invocation', '1.1-outer=1']), { code: 'INVOCATION_INVALID' });
  assert.equal((await countByStep(ws.log))['1.1.2.1'], 4, 'rejected commands run nothing');
});

test('nested LOOP: rerunning an occurrence keeps earlier occurrences and retires the later ones', async t => {
  const ws = await workspace(t, nestedLoop);
  await dev(ws);
  const target = await dev(ws, ['--step', '1.1.2.1', '--invocation', invocationOf(2, 1)]);
  assert.equal(target.status, 'COMPLETED');
  assert.deepEqual([target.dev.executed, target.dev.reused], [1, 7], 'outer iteration 1 and a(O2) are reused');
  assert.equal(target.dev.target.address, occurrence(2, 1));
  assert.equal((await countByStep(ws.log))['1.1.2.1'], 5);

  const rest = await dev(ws);
  assert.equal(rest.status, 'COMPLETED');
  // b#5 (O2,I1) now passes both gates, so iteration 3 of the outer loop is no longer reached.
  assert.deepEqual([rest.dev.executed, rest.dev.reused], [3, 8]);
  assert.deepEqual(await countByStep(ws.log), { '1.1.1': 3, '1.1.2.1': 5, '1.1.2.2': 5, '1.1.3': 4, '1.2': 2 });
  assert.deepEqual(rest.invocations.filter(i => i.action === 'REUSED').map(i => i.address).sort(), [
    '1.1.1@1.1-outer=1', '1.1.1@1.1-outer=2', occurrence(1, 1), occurrence(1, 2), occurrence(2, 1),
    '1.1.2.2@1.1-outer=1,1.1-outer/1.1.2-inner=1', '1.1.2.2@1.1-outer=1,1.1-outer/1.1.2-inner=2', '1.1.3@1.1-outer=1',
  ].sort());
  assert.equal(rest.steps['1.1.2.1'].reused.runId, target.runId, 'the reused b(O2,I1) is the one executed by the previous command');
});

test('nested LOOP: retesting the first occurrence shortens the loop; an occurrence that is no longer reached is refused', async t => {
  const ws = await workspace(t, nestedLoop);
  await dev(ws);
  await dev(ws, ['--step', '1.1.2.1', '--invocation', invocationOf(1, 1)]);
  const rest = await dev(ws);
  assert.deepEqual([rest.dev.executed, rest.dev.reused], [3, 2]);
  assert.deepEqual(await countByStep(ws.log), { '1.1.1': 3, '1.1.2.1': 5, '1.1.2.2': 5, '1.1.3': 4, '1.2': 2 });
  const gone = await dev(ws, ['--step', '1.1.2.1', '--invocation', invocationOf(3, 1)]);
  assert.equal(gone.status, 'FAILED');
  assert.equal(gone.error.code, 'TARGET_UNREACHABLE');
  assert.equal((await countByStep(ws.log))['1.1.2.1'], 5);
});

test('precontext excludes the step itself and later steps', () => {
  const context = { input: {}, steps: {
    '1.1': { resultId: 'r1', ord: 3 }, '1.2': { resultId: 'r2', ord: 4 }, '1.3': { resultId: 'r3', ord: 5 }, '1.4': { resultId: 'r4', ord: 6 },
  } };
  assert.deepEqual(precontext(context, 5).map(([id]) => id), ['1.1', '1.2']);
  assert.deepEqual(precontext(context, 3), []);
});

const fanOut = {
  '1.1-seed.md': 'OUTPUT::seed',
  '1.2-fan/FLOW.json': flow({ type: 'parallel' }),
  '1.2-fan/1.2.1-a.md': 'Seed={{ steps["1.1"].output }}\nOUTPUT::a#{n}',
  '1.2-fan/1.2.2-b.md': 'FAIL_IF_EXISTS::b.flag\nOUTPUT::b#{n}',
  '1.2-fan/1.2.3-c.md': 'OUTPUT::c#{n}',
  '1.3-join.md': 'A={{ steps["1.2.1"].output }} B={{ steps["1.2.2"].output }} C={{ steps["1.2.3"].output }}\nOUTPUT::join#{n}',
};

test('PARALLEL: a cold --step inside a branch runs only that branch', async t => {
  const ws = await workspace(t, fanOut);
  const state = await dev(ws, ['--step', '1.2.2']);
  assert.equal(state.status, 'COMPLETED');
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.2': 1 }, 'sibling branches and the join are not touched');
});

test('PARALLEL: a failed branch keeps its siblings; only it and the join are redone', async t => {
  const ws = await workspace(t, fanOut);
  await put(ws.dir, 'b.flag', 'x');
  const failed = await dev(ws);
  assert.equal(failed.status, 'FAILED');
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.2.2': 1, '1.2.3': 1 }, 'siblings finished and were recorded; the join never ran');
  const digests = failed.invocations.filter(i => ['1.2.1', '1.2.2', '1.2.3'].includes(i.step)).map(i => i.upstreamDigest);
  assert.equal(new Set(digests).size, 1, 'branches share the same upstream snapshot');

  await rm(path.join(ws.dir, 'b.flag'));
  const healed = await dev(ws);
  assert.equal(healed.status, 'COMPLETED');
  assert.deepEqual([healed.dev.executed, healed.dev.reused], [2, 3]);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.2.2': 2, '1.2.3': 1, '1.3': 1 });
  assert.match((await calls(ws.log)).find(c => c.step === '1.3').prompt, /A=a#1 B=b#2 C=c#1/);

  const only = await dev(ws, ['--step', '1.2.2']);
  assert.deepEqual([only.dev.executed, only.dev.reused], [1, 1]);
  assert.equal((await countByStep(ws.log))['1.3'], 1, 'target stops before the join');
  const after = await dev(ws);
  assert.deepEqual([after.dev.executed, after.dev.reused], [1, 4]);
  assert.match((await calls(ws.log)).filter(c => c.step === '1.3').at(-1).prompt, /A=a#1 B=b#3 C=c#1/);
});

test('each dev command pins its sources; edits made while it runs apply to the next command', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::a\nWRITE::1.2-b.md::OUTPUT::edited',
    '1.2-b.md': 'OUTPUT::original',
  });
  const first = await dev(ws);
  assert.equal((await readFile(first.steps['1.2'].artifact, 'utf8')), 'original');
  assert.match(await readFile(path.join(ws.dir, '1.2-b.md'), 'utf8'), /edited/);
  const second = await dev(ws);
  assert.deepEqual([second.dev.executed, second.dev.reused], [1, 1]);
  assert.equal((await readFile(second.steps['1.2'].artifact, 'utf8')), 'edited');
});

test('dev and run never share results, in either direction', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a#{n}', '1.2-b.md': 'OUTPUT::b#{n}' });
  const prod = () => cli(['run', ws.dir, ...agentArgs(ws.log), '--json'], ws.dir);
  const firstRun = JSON.parse((await prod()).output);
  assert.equal(firstRun.mode, undefined, 'run state keeps its original shape');
  assert.equal(firstRun.dev, undefined);
  const state = await dev(ws);
  assert.equal(state.dev.reused, 0, 'dev does not import the run');
  await prod();
  assert.deepEqual(await countByStep(ws.log), { '1.1': 3, '1.2': 3 });
  const again = await dev(ws);
  assert.deepEqual([again.dev.executed, again.dev.reused], [0, 2], 'dev still reuses its own results');
  const status = await cli(['status', state.runId], ws.dir);
  assert.match(status.output, /Dev: session .* scope full workflow/);
  assert.match((await cli(['status', firstRun.runId], ws.dir)).output, /COMPLETED/);
});

test('sessions are isolated by input and by the full executor command, not by timeouts', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'Topic={{ input.topic }}\nOUTPUT::a#{n}' }, { input: { topic: 'coffee' } });
  const base = await dev(ws);
  assert.equal((await dev(ws)).dev.sessionId, base.dev.sessionId);

  const tea = await dev(ws, ['--var', 'topic=tea']);
  assert.notEqual(tea.dev.sessionId, base.dev.sessionId, 'different input');
  assert.equal(tea.dev.executed, 1);

  const flagged = await dev(ws, [], { agentExtra: ['--extra-flag'] });
  assert.notEqual(flagged.dev.sessionId, base.dev.sessionId, 'same executable, different argument');
  assert.notEqual(flagged.dev.sessionId, tea.dev.sessionId);

  await writeFile(path.join(ws.dir, 'awe.json'), JSON.stringify({ input: { topic: 'coffee' }, executor: { timeoutMs: 9000 } }));
  const slower = await dev(ws);
  assert.equal(slower.dev.sessionId, base.dev.sessionId, 'timeout does not change results');
  assert.equal(slower.dev.reused, 1);

  const fresh = await dev(ws, ['--fresh']);
  assert.notEqual(fresh.dev.sessionId, base.dev.sessionId);
  assert.equal(fresh.dev.executed, 1);
  assert.equal((await dev(ws)).dev.sessionId, fresh.dev.sessionId, 'the newest compatible session is the default');
});

test('legacy runs stay readable and untrusted session data is never used as a cache', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a#{n}' });
  const legacy = JSON.parse((await cli(['run', ws.dir, ...agentArgs(ws.log), '--json'], ws.dir)).output);
  await put(ws.dir, '.awe/dev/dev-old/session.json', JSON.stringify({ schema: 0, id: 'dev-old', records: {} }));
  await put(ws.dir, '.awe/dev/dev-broken/session.json', '{ not json');
  await put(ws.dir, '.awe/dev/dev-forged/session.json', JSON.stringify({ schema: 1, id: 'dev-forged', compat: {}, records: {}, lastUsedAt: '2999-01-01' }));
  const state = await dev(ws);
  assert.equal(state.dev.executed, 1);
  assert.notEqual(state.dev.sessionId, 'dev-old');
  assert.match((await cli(['status', legacy.runId], ws.dir)).output, /COMPLETED/);
  assert.equal(JSON.parse((await cli(['inspect', legacy.runId], ws.dir)).output).runId, legacy.runId);
});

test('dev option handling', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a' });
  for (const args of [['run', ws.dir, '--invocation', 'x'], ['run', ws.dir, '--fresh'], ['simulate', ws.dir, '--acknowledge', '1.1']]) {
    await assert.rejects(cli(args, ws.dir), { code: 'CLI_USAGE' });
  }
  await assert.rejects(dev(ws, ['--invocation', '1.1-x=1']), { code: 'CLI_USAGE' });
  await assert.rejects(dev(ws, ['--step', '9.9']), { code: 'DEV_TARGET_NOT_FOUND' });
  await assert.rejects(dev(ws, ['--step', '1.1', '--invocation', 'x=1']), { code: 'INVOCATION_INVALID' });
  await assert.rejects(dev(ws, ['--acknowledge']), { code: 'CLI_USAGE' });
  await assert.rejects(dev(ws, ['--acknowledge', '1.1']), { code: 'ACKNOWLEDGE_UNKNOWN' });
  assert.match((await cli(['--help'], ws.dir)).output, /awe dev .*--step/);
  assert.equal((await countByStep(ws.log))['1.1'], undefined, 'usage errors start no executor');
});
