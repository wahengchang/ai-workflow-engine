import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../src/cli.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/awe.js', import.meta.url));
const markerExecutor = {
  type: 'command',
  argv: [process.execPath, '-e', "require('node:fs').writeFileSync('executor-called','yes'); process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('generated result'))"],
};
async function fixture(t, files = {}, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-simulate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    'ENTRY.md': 'Audience: {{ input.audience }}',
    'awe.json': JSON.stringify({ input: { audience: 'writer' }, ...config }),
    '1.1-draft.md': 'Write an article for {{ input.audience }}',
    ...files,
  })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), value);
  }
  return dir;
}
function stateFile(dir, id) {
  return path.join(dir, '.awe', 'runs', id, 'state.json');
}
async function stateFromText(dir, output) {
  const id = /Run: (\S+)/.exec(output)[1];
  return JSON.parse(await readFile(stateFile(dir, id), 'utf8'));
}

test('simulate overrides configured command; the same command still executes via run', async t => {
  const dir = await fixture(t, { '1.2-review.md': 'Review: {{ steps["1.1"].output }}' }, { executor: markerExecutor });
  const result = await cli(['simulate', dir, '--var', 'audience=editor\n{{literal}}']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Status: COMPLETED\nExecution: SIMULATED \(echo; no AI calls\)/);
  await assert.rejects(readFile(path.join(dir, 'executor-called')), { code: 'ENOENT' });
  const state = await stateFromText(dir, result.output);
  assert.equal(state.executionMode, 'SIMULATED');
  assert.deepEqual(state.executor, { type: 'echo' });
  const artifact = await readFile(state.steps['1.2'].artifact, 'utf8');
  assert.ok(artifact.includes('Audience: editor\n{{literal}}'));
  assert.ok(artifact.includes('Write an article for editor\n{{literal}}'));
  assert.ok(!artifact.includes('generated result'));
  assert.match((await cli(['status', state.runId], dir)).output, /Execution: SIMULATED/);
  assert.equal(JSON.parse((await cli(['inspect', state.runId], dir)).output).executionMode, 'SIMULATED');

  const actual = await cli(['run', dir, '--json']);
  assert.equal(actual.code, 0);
  const actualState = JSON.parse(actual.output);
  assert.equal(actualState.executionMode, 'COMMAND');
  assert.equal(await readFile(path.join(dir, 'executor-called'), 'utf8'), 'yes');
  assert.equal(await readFile(actualState.steps['1.2'].artifact, 'utf8'), 'generated result');
  assert.match((await cli(['status', actualState.runId], dir)).output, /Execution: COMMAND \(external executor\)/);
});

test('simulate requires no installed command or valid command executor settings', async t => {
  for (const executor of [
    { type: 'command', argv: ['awe-nonexistent-executor'], timeoutMs: -1 },
    { type: 'command' },
    { type: 'not-a-supported-executor' },
  ]) {
    const dir = await fixture(t, {}, { executor });
    const result = await cli(['simulate', dir, '--json']);
    assert.equal(result.code, 0, result.output);
    const state = JSON.parse(result.output);
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.executionMode, 'SIMULATED');
    assert.deepEqual(state.executor, { type: 'echo' });
  }
});

test('simulate rejects executor flags before creating a run', async t => {
  const dir = await fixture(t, {}, { executor: markerExecutor });
  for (const args of [
    ['--executor', 'command'], ['--executor', 'echo'], ['--command', process.execPath], ['--arg', '-p'],
  ]) {
    await assert.rejects(cli(['simulate', dir, ...args]), { code: 'CLI_USAGE' });
  }
  await assert.rejects(readdir(path.join(dir, '.awe')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(dir, 'executor-called')), { code: 'ENOENT' });
});

test('default and explicit echo run keep status/exit codes and disclose simulation', async t => {
  const dir = await fixture(t);
  for (const args of [[], ['--executor', 'echo']]) {
    const result = await cli(['run', dir, ...args]);
    assert.equal(result.code, 0);
    assert.match(result.output, /^Run: \S+\nStatus: COMPLETED\nExecution: SIMULATED/);
    const state = await stateFromText(dir, result.output);
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.executionMode, 'SIMULATED');
    const status = JSON.parse((await cli(['status', state.runId, '--json'], dir)).output);
    assert.equal(status.executionMode, 'SIMULATED');
  }
});

test('simulation follows input IF routing and parallel joins without inventing verdicts', async t => {
  const dir = await fixture(t, {
    '1.2-if/FLOW.json': JSON.stringify({ type: 'if', test: '{{ input.audience }}', equals: 'writer', then: 'yes', else: 'no' }),
    '1.2-if/yes/1.2.1-parallel/FLOW.json': '{"type":"parallel"}',
    '1.2-if/yes/1.2.1-parallel/1.2.1.1-a.md': 'Review draft: {{ steps["1.1"].artifact }}',
    '1.2-if/yes/1.2.1-parallel/1.2.1.2-b.md': 'Review draft: {{ steps["1.1"].output }}',
    '1.2-if/no/1.2.2-other.md': 'Other audience',
  }, { executor: markerExecutor });
  const result = await cli(['simulate', dir, '--json']);
  assert.equal(result.code, 0);
  const state = JSON.parse(result.output);
  assert.ok(state.steps['1.2.1.1']);
  assert.ok(state.steps['1.2.1.2']);
  assert.ok(!state.steps['1.2.2']);
  assert.ok(state.events.some(e => e.type === 'PARALLEL_JOIN'));
  await assert.rejects(readFile(path.join(dir, 'executor-called')), { code: 'ENOENT' });

  const loop = await fixture(t, {
    '1.2-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.2.1"].output }}', equals: 'PASS', maxIterations: 2 }),
    '1.2-loop/1.2.1-verdict.md': 'Your entire reply must be PASS',
    '1.3-deliver.md': 'Final content',
  });
  const failed = await cli(['simulate', loop, '--json']);
  assert.equal(failed.code, 1);
  const failedState = JSON.parse(failed.output);
  assert.equal(failedState.executionMode, 'SIMULATED');
  assert.equal(failedState.status, 'FAILED');
  assert.equal(failedState.error.code, 'LOOP_EXHAUSTED');
  assert.equal(failedState.steps['1.2.1'].attempts, 2);
  assert.ok(!failedState.steps['1.3']);
  assert.match((await cli(['status', failedState.runId], loop)).output, /Execution: SIMULATED/);
});

test('status infers legacy mode without rewriting stored state', async t => {
  const dir = await fixture(t);
  for (const [executor, mode] of [[{ type: 'echo' }, 'SIMULATED'], [{ type: 'command' }, 'COMMAND'], [undefined, 'UNKNOWN']]) {
    const id = `legacy-${mode}`;
    const file = stateFile(dir, id);
    const original = JSON.stringify({ version: 1, runId: id, status: 'COMPLETED', executor, steps: {} });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    const result = await cli(['status', id], dir);
    assert.match(result.output, new RegExp(`Execution: ${mode}`));
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('bin simulate emits pure JSON, retains error exits, and propagates cancellation', async t => {
  const dir = await fixture(t, {}, { executor: markerExecutor });
  const success = await exec(process.execPath, [bin, 'simulate', dir, '--json']);
  assert.equal(success.stderr, '');
  assert.equal(JSON.parse(success.stdout).executionMode, 'SIMULATED');
  await assert.rejects(readFile(path.join(dir, 'executor-called')), { code: 'ENOENT' });

  await writeFile(path.join(dir, '1.1-draft.md'), '{{ input.missing }}');
  await assert.rejects(exec(process.execPath, [bin, 'simulate', dir, '--json']), error => {
    assert.equal(error.code, 1);
    const state = JSON.parse(error.stdout);
    assert.equal(state.executionMode, 'SIMULATED');
    assert.equal(state.error.code, 'MISSING_REFERENCE');
    return true;
  });

  const controller = new AbortController();
  controller.abort();
  const interrupted = await cli(['simulate', dir, '--json'], dir, { signal: controller.signal });
  assert.equal(interrupted.code, 1);
  const state = JSON.parse(interrupted.output);
  assert.equal(state.status, 'INTERRUPTED');
  assert.equal(state.executionMode, 'SIMULATED');
  assert.deepEqual(state.steps, {});
});
