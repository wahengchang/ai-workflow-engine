import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, put, run, resume, calls, countByStep, flow, agentCommand } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';
import { precontext } from '../src/engine.js';

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `1.${from + i}`);

test('100 steps: --step runs 1-49 once, retests 50 three times, then a cached whole run finishes 51-100 without rerunning 50', async t => {
  const files = {};
  for (let n = 1; n <= 100; n++) {
    files[`1.${n}-step.md`] = `${n === 1 ? 'start' : `Prev={{ steps["1.${n - 1}"].output }}`}\nOUTPUT::s${n}#{n}`;
  }
  const ws = await workspace(t, files);

  const first = await run(ws, ['1.50']);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.stoppedAfter, '1.50');
  assert.deepEqual([first.executed, first.reused], [50, 0]);
  const afterFirst = await countByStep(ws.log);
  assert.deepEqual(Object.keys(afterFirst), ids(1, 50), 'only 1-50 ran; nothing after the target');
  assert.ok(Object.values(afterFirst).every(count => count === 1));

  const upstreamDigests = [first.invocations.find(i => i.step === '1.50').upstreamDigest];
  for (const version of ['v2', 'v3']) {
    await put(ws.dir, '1.50-step.md', `Prev={{ steps["1.49"].output }}\nOUTPUT::s50-${version}#{n}`);
    const rerun = await run(ws, ['1.50']);
    assert.equal(rerun.status, 'COMPLETED');
    assert.equal(rerun.session, first.session);
    assert.deepEqual([rerun.executed, rerun.reused], [1, 49]);
    upstreamDigests.push(rerun.invocations.find(i => i.step === '1.50' && i.action === 'EXECUTED').upstreamDigest);
  }
  assert.equal(new Set(upstreamDigests).size, 1, 'upstream context of step 50 is identical across the three tests');
  const afterThree = await countByStep(ws.log);
  assert.equal(afterThree['1.50'], 3);
  for (const id of ids(1, 49)) assert.equal(afterThree[id], 1, `${id} must not be called again`);

  const last = await resume(ws);
  assert.equal(last.status, 'COMPLETED');
  assert.deepEqual([last.executed, last.reused], [50, 50]);
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
  await resume(ws);
  await put(ws.dir, '1.2-b.md', 'A={{ steps["1.1"].output }} OUTPUT::b-edited#{n}');
  const second = await resume(ws);
  assert.deepEqual([second.executed, second.reused], [2, 1]);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2': 2, '1.3': 2 });
  assert.match((await calls(ws.log)).filter(c => c.step === '1.3').at(-1).prompt, /B=b-edited#2/);
});

test('rerunning a step with identical output still invalidates later steps (causal, not by value)', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::same',
    '1.2-b.md': 'A={{ steps["1.1"].output }} OUTPUT::b#{n}',
  });
  await resume(ws);
  await run(ws, ['1.1']);
  const next = await resume(ws);
  assert.deepEqual([next.executed, next.reused], [1, 1]);
  assert.equal((await countByStep(ws.log))['1.2'], 2);
});

test('a failed rerun blocks downstream from silently using the previous success', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::a',
    '1.2-b.md': 'FAIL_IF_EXISTS::block.flag\nOUTPUT::b#{n}',
    '1.3-c.md': 'B={{ steps["1.2"].output }} OUTPUT::c#{n}',
  });
  assert.equal((await resume(ws)).status, 'COMPLETED');
  await put(ws.dir, 'block.flag', 'x');

  const failed = await run(ws, ['1.2']);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error.code, 'EXECUTOR_FAILED');

  const blocked = await resume(ws);
  assert.equal(blocked.status, 'FAILED', 'dev . must not fall back to the old success of 1.2');
  assert.equal(blocked.invocations.some(i => i.step === '1.3'), false, 'step 1.3 is not run or reused');
  const viaDownstream = await run(ws, ['1.3']);
  assert.equal(viaDownstream.status, 'FAILED');
  assert.equal((await countByStep(ws.log))['1.3'], 1, '1.3 never ran again');

  await rm(path.join(ws.dir, 'block.flag'));
  const recovered = await resume(ws);
  assert.equal(recovered.status, 'COMPLETED');
  assert.deepEqual([recovered.executed, recovered.reused], [2, 1]);
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
  await resume(ws);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.3': 1 });

  await put(ws.dir, 'verdict.txt', 'FAIL');
  const stillOld = await run(ws, ['1.2.1']);
  assert.equal(stillOld.status, 'COMPLETED', 'the judge result is reused, so the gate still selects the old branch');

  await run(ws, ['1.1']);
  const refused = await run(ws, ['1.2.1']);
  assert.equal(refused.status, 'FAILED');
  assert.equal(refused.error.code, 'TARGET_UNREACHABLE');
  assert.equal((await countByStep(ws.log))['1.2.1'], 2, 'the unselected branch was not executed');

  const flipped = await resume(ws);
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
const iteration = (outer, inner) => `${outer}.${inner}`;

test('nested LOOP: occurrences are addressed separately from attempts', async t => {
  const ws = await workspace(t, nestedLoop);
  const state = await resume(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const b = state.invocations.filter(i => i.step === '1.1.2.1');
  assert.deepEqual(b.map(i => i.address), [occurrence(1, 1), occurrence(1, 2), occurrence(2, 1), occurrence(3, 1)]);
  assert.deepEqual(b.map(i => i.attempt), [1, 2, 3, 4], 'one attempt per execution');
  assert.equal(state.steps['1.1.2.1'].attempts, 4);

  await assert.rejects(run(ws, ['1.1.2.1']), error => {
    assert.equal(error.code, 'ITERATION_REQUIRED');
    for (const [o, i] of [[1, 1], [1, 2], [2, 1], [3, 1]]) assert.ok(error.message.includes(`1.1.2.1@${iteration(o, i)}`), `lists 1.1.2.1@${iteration(o, i)}`);
    return true;
  });
  await assert.rejects(run(ws, ['1.1.2.1@nonsense']), { code: 'CLI_USAGE' });
  await assert.rejects(run(ws, ['1.1.2.1@2']), { code: 'ITERATION_INVALID', message: /Write it as 1\.1\.2\.1@<1-3>\.<1-3>/ });
  await assert.rejects(run(ws, ['1.1.2.1@9.1']), { code: 'ITERATION_INVALID' });
  await assert.rejects(run(ws, ['1.2@1']), { code: 'ITERATION_INVALID' });
  assert.equal((await countByStep(ws.log))['1.1.2.1'], 4, 'rejected commands run nothing');
});

test('nested LOOP: rerunning an occurrence keeps earlier occurrences and retires the later ones', async t => {
  const ws = await workspace(t, nestedLoop);
  await resume(ws);
  const target = await run(ws, ['1.1.2.1@2.1']);
  assert.equal(target.status, 'COMPLETED');
  assert.deepEqual([target.executed, target.reused], [1, 7], 'outer iteration 1 and a(O2) are reused');
  assert.equal(target.target.address, '1.1.2.1@2.1');
  assert.equal((await countByStep(ws.log))['1.1.2.1'], 5);

  const rest = await resume(ws);
  assert.equal(rest.status, 'COMPLETED');
  // b#5 (O2,I1) now passes both gates, so iteration 3 of the outer loop is no longer reached.
  assert.deepEqual([rest.executed, rest.reused], [3, 8]);
  assert.deepEqual(await countByStep(ws.log), { '1.1.1': 3, '1.1.2.1': 5, '1.1.2.2': 5, '1.1.3': 4, '1.2': 2 });
  assert.deepEqual(rest.invocations.filter(i => i.action === 'REUSED').map(i => i.address).sort(), [
    '1.1.1@1.1-outer=1', '1.1.1@1.1-outer=2', occurrence(1, 1), occurrence(1, 2), occurrence(2, 1),
    '1.1.2.2@1.1-outer=1,1.1-outer/1.1.2-inner=1', '1.1.2.2@1.1-outer=1,1.1-outer/1.1.2-inner=2', '1.1.3@1.1-outer=1',
  ].sort());
  assert.equal(rest.steps['1.1.2.1'].reused.runId, target.runId, 'the reused b(O2,I1) is the one executed by the previous command');
});

test('nested LOOP: retesting the first occurrence shortens the loop; an occurrence that is no longer reached is refused', async t => {
  const ws = await workspace(t, nestedLoop);
  await resume(ws);
  await run(ws, ['1.1.2.1@1.1']);
  const rest = await resume(ws);
  assert.deepEqual([rest.executed, rest.reused], [3, 2]);
  assert.deepEqual(await countByStep(ws.log), { '1.1.1': 3, '1.1.2.1': 5, '1.1.2.2': 5, '1.1.3': 4, '1.2': 2 });
  const gone = await run(ws, ['1.1.2.1@3.1']);
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
  const state = await run(ws, ['1.2.2']);
  assert.equal(state.status, 'COMPLETED');
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.2': 1 }, 'sibling branches and the join are not touched');
});

test('PARALLEL: a failed branch keeps its siblings; only it and the join are redone', async t => {
  const ws = await workspace(t, fanOut);
  await put(ws.dir, 'b.flag', 'x');
  const failed = await resume(ws);
  assert.equal(failed.status, 'FAILED');
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.2.2': 1, '1.2.3': 1 }, 'siblings finished and were recorded; the join never ran');
  const digests = failed.invocations.filter(i => ['1.2.1', '1.2.2', '1.2.3'].includes(i.step)).map(i => i.upstreamDigest);
  assert.equal(new Set(digests).size, 1, 'branches share the same upstream snapshot');

  await rm(path.join(ws.dir, 'b.flag'));
  const healed = await resume(ws);
  assert.equal(healed.status, 'COMPLETED');
  assert.deepEqual([healed.executed, healed.reused], [2, 3]);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.2.2': 2, '1.2.3': 1, '1.3': 1 });
  assert.match((await calls(ws.log)).find(c => c.step === '1.3').prompt, /A=a#1 B=b#2 C=c#1/);

  const only = await run(ws, ['1.2.2']);
  assert.deepEqual([only.executed, only.reused], [1, 1]);
  assert.equal((await countByStep(ws.log))['1.3'], 1, 'target stops before the join');
  const after = await resume(ws);
  assert.deepEqual([after.executed, after.reused], [1, 4]);
  assert.match((await calls(ws.log)).filter(c => c.step === '1.3').at(-1).prompt, /A=a#1 B=b#3 C=c#1/);
});

test('each run pins its sources; edits made while it runs apply to the next command', async t => {
  const ws = await workspace(t, {
    '1.1-a.md': 'OUTPUT::a\nWRITE::1.2-b.md::OUTPUT::edited',
    '1.2-b.md': 'OUTPUT::original',
  });
  const first = await resume(ws);
  assert.equal((await readFile(first.steps['1.2'].artifact, 'utf8')), 'original');
  assert.match(await readFile(path.join(ws.dir, '1.2-b.md'), 'utf8'), /edited/);
  const second = await resume(ws);
  assert.deepEqual([second.executed, second.reused], [1, 1]);
  assert.equal((await readFile(second.steps['1.2'].artifact, 'utf8')), 'edited');
});

test('a whole run starts clean unless asked to use the cache; naming a step uses it', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a#{n}', '1.2-b.md': 'OUTPUT::b#{n}' });
  const first = await run(ws);
  assert.deepEqual([first.cache, first.executed, first.reused], [false, 2, 0]);
  const second = await run(ws);
  assert.deepEqual([second.cache, second.executed, second.reused], [false, 2, 0], 'a whole run ignores the cache');
  const cached = await run(ws, ['--cache']);
  assert.deepEqual([cached.cache, cached.executed, cached.reused], [true, 0, 2], '--cache reuses valid steps');
  const stepRun = await run(ws, ['1.2']);
  assert.deepEqual([stepRun.cache, stepRun.executed, stepRun.reused], [true, 1, 1], 'a named step reruns, upstream is reused');
  const noCache = await run(ws, ['1.2', '--no-cache']);
  assert.deepEqual([noCache.cache, noCache.executed, noCache.reused], [false, 2, 0], '--no-cache reruns upstream too');
  assert.deepEqual(await countByStep(ws.log), { '1.1': 3, '1.2': 4 });
  const after = await run(ws, ['--cache']);
  assert.deepEqual([after.executed, after.reused], [0, 2], 'every run feeds the one cache');
  await assert.rejects(cli(['run', ws.dir, '--cache', '--no-cache']), { code: 'CLI_USAGE', message: /one switch/ });
});

test('the cache is isolated by input and by the whole command line, not by timeouts', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'Topic={{ input.topic }}\nOUTPUT::a#{n}' }, { input: { topic: 'coffee' } });
  const base = await resume(ws);
  assert.equal((await resume(ws)).session, base.session);

  const tea = await resume(ws, ['--var', 'topic=tea']);
  assert.notEqual(tea.session, base.session, 'different input');
  assert.equal(tea.executed, 1);

  const config = extra => writeFile(path.join(ws.dir, 'awe.json'), JSON.stringify({ version: 2, input: { topic: 'coffee' }, ...extra }));
  await config({ run: agentCommand(ws.log, ['--extra-flag']) });
  const flagged = await resume(ws);
  assert.equal(flagged.session, base.session, 'the session is per workflow and input');
  assert.equal(flagged.executed, 1, 'same executable, different argument: the result is not reused');
  assert.equal(flagged.reused, 0);

  await config({ run: agentCommand(ws.log, ['--extra-flag']), timeout: 9000 });
  const slower = await resume(ws);
  assert.equal(slower.reused, 1, 'timeout does not change results');
});

test('untrusted session data is never used as a cache', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a#{n}' });
  await put(ws.dir, '.awe/cache/cache-old/session.json', JSON.stringify({ schema: 0, id: 'cache-old', records: {} }));
  await put(ws.dir, '.awe/cache/cache-broken/session.json', '{ not json');
  await put(ws.dir, '.awe/cache/cache-forged/session.json', JSON.stringify({ schema: 1, id: 'cache-forged', compat: {}, records: {}, lastUsedAt: '2999-01-01' }));
  const state = await resume(ws);
  assert.equal(state.executed, 1);
  assert.notEqual(state.session, 'cache-old');
  assert.notEqual(state.session, 'cache-forged');
});

test('run option handling', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::a' });
  for (const args of [['--invocation', 'x'], ['--fresh'], ['--acknowledge', '1.1'], ['--step', '1.1'], ['--retry'], ['--timeout', '0'], ['--timeout'], ['--var', 'novalue'], ['--dry', '--no-cache'], ['--dry', '--executor', 'run'], ['1.1', '1.1']]) {
    await assert.rejects(cli(['run', ws.dir, ...args], ws.dir), { code: 'CLI_USAGE' }, args.join(' '));
  }
  await assert.rejects(run(ws, ['9.9']), { code: 'STEP_NOT_FOUND', message: /No step "9\.9"\. Steps: 1\.1/ });
  await assert.rejects(run(ws, ['--retry', '1.1']), { code: 'RETRY_UNKNOWN' });
  assert.match((await cli(['--help'], ws.dir)).output, /awe run .*\[step\]/);
  assert.equal((await countByStep(ws.log))['1.1'], undefined, 'usage errors start no executor');
});
