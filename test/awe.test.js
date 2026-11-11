import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEntry } from '../src/entry.js';
import { discoverWorkflow } from '../src/discover.js';
import { renderTemplate } from '../src/template.js';
import { runWorkflow } from '../src/engine.js';
import { cli } from '../src/cli.js';

const fakeAgent = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'fixtures', 'fake-agent.cjs');
const executor = { name: 'run', argv: [process.execPath, fakeAgent], display: 'fake agent', timeoutMs: 3000 };

async function fixture(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'ENTRY.md'), '# System context\nUse concise language.');
  for (const [filename, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, filename)), { recursive: true });
    await writeFile(path.join(dir, filename), content);
  }
  return dir;
}

async function run(dir, opts = {}) {
  const entry = await loadEntry(dir);
  const tree = await discoverWorkflow(dir);
  return runWorkflow(entry, tree, { resolveExecutor: () => executor, ...opts });
}

test('sequential numeric ordering and explicit input/output references', async t => {
  const dir = await fixture(t, {
    '1.2-second.md': 'Previous={{ steps["1.1"].output }} OUTPUT::final',
    '1.1-first.md': 'Topic={{ input.topic }} OUTPUT::research',
  });
  const state = await run(dir, { input: { topic: 'coffee' } });
  assert.equal(state.status, 'COMPLETED');
  assert.deepEqual(Object.keys(state.steps), ['1.1', '1.2']);
  const events = state.events.filter(e => e.type === 'STEP_COMPLETED').map(e => e.node);
  assert.deepEqual(events, ['1.1', '1.2']);
  assert.equal((await readFile(state.steps['1.2'].artifact, 'utf8')), 'final');
  assert.equal(state.input.topic, 'coffee');
});

test('IF folder selects one branch using output from a previous prompt step', async t => {
  const dir = await fixture(t, {
    '1.1-judge.md': 'RETURN_PASS',
    '1.2-routing/FLOW.json': JSON.stringify({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'PASS', then: 'approved', else: 'rejected' }),
    '1.2-routing/approved/1.2.1-yes.md': 'OUTPUT::yes',
    '1.2-routing/rejected/1.2.2-no.md': 'OUTPUT::no',
    '1.3-finish.md': 'OUTPUT::finished',
  });
  const state = await run(dir);
  assert.equal(state.status, 'COMPLETED');
  assert.ok(state.steps['1.2.1']);
  assert.ok(!state.steps['1.2.2']);
  assert.ok(state.steps['1.3']);
  assert.equal(state.events.find(e => e.type === 'IF_BRANCH').branch, 'approved');
});

test('LOOP repeats its own children and stops at explicit exit result', async t => {
  const dir = await fixture(t, {
    '1.1-review-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-review-loop/1.1.1-judge.md': 'RETRY_ONCE',
    '1.2-done.md': 'OUTPUT::done',
  });
  const state = await run(dir);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.steps['1.1.1'].attempts, 2);
  assert.equal(state.events.find(e => e.type === 'LOOP_COMPLETED').iteration, 2);
  assert.ok(state.steps['1.2']);
});

test('bounded LOOP fails rather than hanging indefinitely', async t => {
  const dir = await fixture(t, {
    '1.1-review-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.1"].output }}', equals: 'PASS', maxIterations: 2 }),
    '1.1-review-loop/1.1.1-judge.md': 'RETURN_FAIL',
  });
  const state = await run(dir);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error.code, 'LOOP_EXHAUSTED');
  assert.equal(state.steps['1.1.1'].attempts, 2);
});

test('PARALLEL joins children before starting the next numbered step', async t => {
  const dir = await fixture(t, {
    '1.1-checks/FLOW.json': JSON.stringify({ type: 'parallel' }),
    '1.1-checks/1.1.1-facts.md': 'DELAY_150 OUTPUT::facts',
    '1.1-checks/1.1.2-seo.md': 'DELAY_150 OUTPUT::seo',
    '1.2-finish.md': 'OUTPUT::finish',
  });
  const state = await run(dir);
  assert.equal(state.status, 'COMPLETED');
  const join = state.events.findIndex(e => e.type === 'PARALLEL_JOIN');
  const next = state.events.findIndex(e => e.type === 'STEP_STARTED' && e.node === '1.2');
  assert.ok(join >= 0 && next > join);
  assert.equal((await readFile(state.steps['1.1.1'].artifact, 'utf8')), 'facts');
  assert.equal((await readFile(state.steps['1.1.2'].artifact, 'utf8')), 'seo');
});

test('missing references fail closed and create traceable state', async t => {
  const dir = await fixture(t, { '1.1-missing.md': 'Missing {{ steps["9.9"].output }}' });
  const state = await run(dir);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error.code, 'MISSING_REFERENCE');
  assert.equal(state.steps['1.1'].status, 'FAILED');
  const saved = JSON.parse(await readFile(path.join(dir, '.awe', 'runs', state.runId, 'state.json'), 'utf8'));
  assert.equal(saved.status, 'FAILED');
});

test('discovery rejects duplicate numbers and malformed IF flow', async t => {
  const dir = await fixture(t, { '1.1-one.md': 'a', '1.1-two.md': 'b' });
  await assert.rejects(discoverWorkflow(dir), { code: 'DUPLICATE_STEP' });
  const dir2 = await fixture(t, { '1.1-if/FLOW.json': JSON.stringify({ type: 'if', test: 'PASS' }) });
  await assert.rejects(discoverWorkflow(dir2), { code: 'INVALID_FLOW' });
});

test('renderTemplate does not evaluate arbitrary JavaScript', () => {
  assert.equal(renderTemplate('hi {{ input.topic }}', { input: { topic: 'coffee' }, steps: {} }), 'hi coffee');
  assert.throws(() => renderTemplate('{{ process.exit() }}', { input: {}, steps: {} }), { code: 'INVALID_TEMPLATE' });
});

test('CLI check and run save a discoverable run', async t => {
  const dir = await fixture(t, { '1.1-write.md': 'OUTPUT::hello', 'awe.json': JSON.stringify({ version: 2, run: `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)}` }) });
  const checked = await cli(['check', dir]);
  assert.equal(checked.code, 0);
  assert.match(checked.output, /VALID/);
  assert.match(checked.output, /1\.1/);
  const result = await cli(['run', dir]);
  assert.equal(result.code, 0);
  assert.match(result.output, /1\.1 +ran/);
  const shown = await cli(['show'], dir);
  assert.match(shown.output, /COMPLETED/);
  assert.equal((await cli(['show', '1.1'], dir)).output, 'hello');
  // From a sub-folder of the workflow, awe finds the workflow by walking up.
  await mkdir(path.join(dir, 'notes'));
  assert.equal((await cli(['show', '1.1'], path.join(dir, 'notes'))).output, 'hello');
});
