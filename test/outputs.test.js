import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cli } from '../src/cli.js';
import { loadEntry } from '../src/entry.js';
import { discoverWorkflow } from '../src/discover.js';
import { startRun } from '../src/runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const executor = { type: 'command', argv: [process.execPath, path.join(root, 'fixtures/fake-agent.cjs')], timeoutMs: 3000 };
const exec = promisify(execFile);
async function fixture(t, files = {}, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-outputs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'ENTRY.md': '# Instructions', 'awe.json': JSON.stringify(config), '1.1-draft.md': 'OUTPUT::draft', ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}
async function run(dir, options = {}) {
  return startRun(await loadEntry(dir), await discoverWorkflow(dir), { executor, ...options });
}
async function report(dir, runId) {
  return JSON.parse((await cli(['outputs', runId, '--json'], dir)).output);
}
function stateFile(dir, id) { return path.join(dir, '.awe/runs', id, 'state.json'); }

test('named deliverables persist, print artifact paths, and remain independent of current source', async t => {
  const dir = await fixture(t, { '1.2-final.md': 'OUTPUT::final article' }, { outputs: { article: '1.2' } });
  const result = await cli(['run', dir, '--command', process.execPath, '--arg', executor.argv[1]]);
  assert.equal(result.code, 0);
  assert.match(result.output, /Output article \(step 1\.2, attempt 1\): .*1-2-attempt-1.md/);
  const id = /Run: (\S+)/.exec(result.output)[1];
  const state = JSON.parse(await readFile(stateFile(dir, id), 'utf8'));
  const expected = { stepId: '1.2', attempt: 1, artifact: state.steps['1.2'].artifact };
  assert.deepEqual(state.outputDefinitions, { article: ['1.2'] });
  assert.deepEqual(state.outputs, { article: expected });
  assert.equal(await readFile(expected.artifact, 'utf8'), 'final article');
  await writeFile(path.join(dir, 'awe.json'), 'not JSON anymore');
  await rm(path.join(dir, 'ENTRY.md'));
  const outputs = await report(dir, id);
  assert.equal(outputs.complete, true);
  assert.equal(outputs.executionMode, 'COMMAND');
  assert.deepEqual(outputs.outputs, { article: expected });
  assert.deepEqual(outputs.artifacts.map(a => a.stepId), ['1.1', '1.2']);
  const text = await cli(['outputs', id], dir);
  assert.match(text.output, /Output article/);
  assert.match(text.output, /Latest completed step artifacts:/);
});

test('one deliverable can resolve either IF branch without leaking unchosen artifacts', async t => {
  const dir = await fixture(t, {
    '1.2-if/FLOW.json': JSON.stringify({ type: 'if', test: '{{ input.route }}', equals: 'yes', then: 'yes', else: 'no' }),
    '1.2-if/yes/1.2.1-a.md': 'OUTPUT::approved',
    '1.2-if/no/1.2.2-b.md': 'OUTPUT::human review',
  }, { outputs: { delivery: ['1.2.1', '1.2.2'] } });
  for (const [route, stepId, content] of [['yes', '1.2.1', 'approved'], ['no', '1.2.2', 'human review']]) {
    const state = await run(dir, { input: { route } });
    assert.equal(state.status, 'COMPLETED');
    const outputs = await report(dir, state.runId);
    assert.equal(outputs.outputs.delivery.stepId, stepId);
    assert.equal(await readFile(outputs.outputs.delivery.artifact, 'utf8'), content);
    assert.deepEqual(outputs.artifacts.map(a => a.stepId), ['1.1', stepId]);
  }
});

test('invalid output definitions fail preflight before any executor or run is created', async t => {
  for (const outputs of [null, [], '1.1', { article: '9.9' }, { article: '1.2' }, { article: [] }, { article: [1.1] }, { article: ['1.1', '1.1'] }, { 'bad name': '1.1' }]) {
    const dir = await fixture(t, {
      '1.2-group/1.2.1-a.md': 'OUTPUT::group result',
    }, { outputs });
    for (const command of ['validate', 'plan', 'run', 'simulate']) {
      await assert.rejects(cli([command, dir]), { code: 'INVALID_OUTPUT' });
    }
    await assert.rejects(run(dir), { code: 'INVALID_OUTPUT' });
    await assert.rejects(readdir(path.join(dir, '.awe')), { code: 'ENOENT' });
  }
});

test('missing or ambiguous deliveries fail the run without publishing partial finals', async t => {
  const missing = await fixture(t, {
    '1.2-if/FLOW.json': JSON.stringify({ type: 'if', test: 'no', equals: 'yes', then: 'yes', else: 'no' }),
    '1.2-if/yes/1.2.1-a.md': 'OUTPUT::approved',
    '1.2-if/no/1.2.2-b.md': 'OUTPUT::human review',
  }, { outputs: { delivery: '1.2.1' } });
  const ambiguous = await fixture(t, { '1.2-final.md': 'OUTPUT::final' }, { outputs: { draft: '1.1', article: ['1.1', '1.2'] } });
  for (const [dir, code] of [[missing, 'OUTPUT_NOT_FOUND'], [ambiguous, 'OUTPUT_AMBIGUOUS']]) {
    const result = await cli(['run', dir, '--json']);
    assert.equal(result.code, 1);
    const state = JSON.parse(result.output);
    assert.equal(state.status, 'FAILED');
    assert.equal(state.error.code, code);
    assert.deepEqual(state.outputs, {});
    const outputs = await report(dir, state.runId);
    assert.equal(outputs.complete, false);
    assert.deepEqual(outputs.outputs, {});
    assert.ok(outputs.artifacts.length > 0);
    const text = await cli(['outputs', state.runId], dir);
    assert.equal(text.code, 0); // Inspection succeeds independently of run outcome.
    assert.match(text.output, /Partial results only/);
    assert.match(text.output, /Named outputs: unavailable/);
    assert.match(text.output, new RegExp(code));
  }
});

test('loop deliveries select the last completed attempt and preserve previous artifacts', async t => {
  const dir = await fixture(t, {
    '1.2-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.2.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.2-loop/1.2.1-draft.md': 'OUTPUT::revised',
    '1.2-loop/1.2.2-gate.md': 'RETRY_ONCE',
  }, { outputs: { article: '1.2.1' } });
  const state = await run(dir);
  assert.equal(state.status, 'COMPLETED');
  const outputs = await report(dir, state.runId);
  assert.equal(outputs.outputs.article.attempt, 2);
  assert.match(outputs.outputs.article.artifact, /1-2-1-attempt-2.md$/);
  assert.equal(await readFile(path.join(path.dirname(outputs.outputs.article.artifact), '1-2-1-attempt-1.md'), 'utf8'), 'revised');
});

test('failed retries never promote stale artifacts to deliverables or latest completed entries', async t => {
  const probe = "const fs=require('node:fs');const f='attempt';const n=fs.existsSync(f)?+fs.readFileSync(f):0;fs.writeFileSync(f,String(n+1));process.stdin.resume();process.stdin.on('end',()=>{if(n)process.exit(1);else process.stdout.write('draft')})";
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: 'FAIL', equals: 'PASS', maxIterations: 2 }),
    '1.1-loop/1.1.1-draft.md': 'revise',
  }, { outputs: { article: '1.1.1' } });
  await rm(path.join(dir, '1.1-draft.md'));
  const state = await run(dir, { executor: { type: 'command', argv: [process.execPath, '-e', probe], timeoutMs: 3000 } });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.steps['1.1.1'].attempts, 2);
  assert.equal(state.steps['1.1.1'].status, 'FAILED');
  // v0.1 step state carries the prior artifact into an unsuccessful retry.
  assert.ok(state.steps['1.1.1'].artifact);
  const outputs = await report(dir, state.runId);
  assert.deepEqual(outputs.outputs, {});
  assert.ok(!outputs.artifacts.some(item => item.stepId === '1.1.1'));
});

test('outputs handles legacy states, sorts numeric IDs, and never guesses a final step', async t => {
  const dir = await fixture(t);
  const file = stateFile(dir, 'legacy');
  const original = JSON.stringify({ runId: 'legacy', status: 'COMPLETED', executor: { type: 'echo' }, steps: {
    '2.10': { status: 'COMPLETED', attempts: 1, artifact: '/recorded/2-10.md' },
    '2.2': { status: 'COMPLETED', attempts: 2, artifact: '/recorded/2-2.md' },
    '2.1': { status: 'FAILED', attempts: 2, artifact: '/stale/2-1.md' },
  } });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, original);
  const outputs = await report(dir, 'legacy');
  assert.deepEqual(outputs.outputs, {});
  assert.deepEqual(outputs.artifacts.map(a => a.stepId), ['2.2', '2.10']);
  assert.equal(outputs.executionMode, 'SIMULATED');
  assert.match((await cli(['outputs', 'legacy'], dir)).output, /Named outputs: none declared/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('simulation output remains labeled; interrupted runs expose no final deliverables', async t => {
  const dir = await fixture(t, {}, { outputs: { article: '1.1' }, executor });
  const result = await cli(['simulate', dir, '--json']);
  const state = JSON.parse(result.output);
  assert.equal(result.code, 0);
  const outputs = await report(dir, state.runId);
  assert.equal(outputs.executionMode, 'SIMULATED');
  assert.ok((await readFile(outputs.outputs.article.artifact, 'utf8')).includes('OUTPUT::draft'));
  assert.match((await cli(['outputs', state.runId], dir)).output, /Execution: SIMULATED \(echo; no AI calls\)/);
  const controller = new AbortController(); controller.abort();
  const interrupted = await run(dir, { signal: controller.signal });
  const partial = await report(dir, interrupted.runId);
  assert.equal(partial.status, 'INTERRUPTED');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.outputs, {});
  assert.deepEqual(partial.artifacts, []);
});

test('outputs/status/inspect work outside workflow root and missing runs have actionable errors', async t => {
  const dir = await fixture(t, {}, { outputs: { article: '1.1' } });
  const state = await run(dir);
  const elsewhere = await fixture(t);
  for (const command of ['outputs', 'status', 'inspect']) {
    const result = await cli([command, state.runId, '--workflow', dir, '--json'], elsewhere);
    assert.equal(JSON.parse(result.output).runId, state.runId);
  }
  const { stdout, stderr } = await exec(process.execPath, [path.join(root, 'bin/awe.js'), 'outputs', state.runId, '--workflow', dir, '--json'], { cwd: elsewhere });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).outputs.article.stepId, '1.1');
  await assert.rejects(cli(['outputs', 'missing'], elsewhere), error => {
    assert.equal(error.code, 'RUN_NOT_FOUND');
    assert.match(error.message, /--workflow PATH/);
    assert.ok(!error.message.includes('ENOENT'));
    return true;
  });
  await assert.rejects(cli(['outputs', '../escape'], dir), { code: 'INVALID_RUN_ID' });
  await assert.rejects(cli(['outputs', state.runId, '--workflow'], dir), { code: 'CLI_USAGE' });
  await assert.rejects(cli(['outputs', state.runId, '--step', '1.1'], dir), { code: 'CLI_USAGE' });
  await assert.rejects(cli(['run', dir, '--workflow', dir]), { code: 'CLI_USAGE' });
});

test('an active run exposes completed work as partial and never publishes final deliverables', { timeout: 10000 }, async t => {
  const dir = await fixture(t, { '1.2-wait.md': 'WAIT_HERE' }, { outputs: { article: '1.1' } });
  const controller = new AbortController();
  const probe = "let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{if(p.includes('WAIT_HERE')){require('node:fs').writeFileSync('waiting','yes');setInterval(()=>{},1000)}else process.stdout.write('draft')})";
  const running = run(dir, { signal: controller.signal, executor: { type: 'command', argv: [process.execPath, '-e', probe], timeoutMs: 5000 } });
  t.after(async () => { controller.abort(); await running; });
  const deadline = Date.now() + 3000;
  let ready = false;
  while (Date.now() < deadline) {
    try { await readFile(path.join(dir, 'waiting')); ready = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, 'executor must be active before inspection');
  const [id] = await readdir(path.join(dir, '.awe/runs'));
  const partial = await report(dir, id);
  assert.equal(partial.status, 'RUNNING');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.outputs, {});
  assert.deepEqual(partial.artifacts.map(item => item.stepId), ['1.1']);
  assert.match((await cli(['outputs', id], dir)).output, /Partial results only/);
  controller.abort();
  assert.equal((await running).status, 'INTERRUPTED');
});
