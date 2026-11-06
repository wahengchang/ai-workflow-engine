import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, parseArgs } from '../src/cli.js';
import { loadEntry } from '../src/entry.js';
import { discoverWorkflow } from '../src/discover.js';
import { startRun } from '../src/runtime.js';
import { renderTemplate } from '../src/template.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const agent = path.join(root, 'fixtures/fake-agent.cjs');
const command = { type: 'command', argv: [process.execPath, agent], timeoutMs: 5000 };
async function fixture(t, files, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'ENTRY.md': '# Instructions', 'awe.json': JSON.stringify(config), ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}
async function run(dir, options = {}) {
  return startRun(await loadEntry(dir), await discoverWorkflow(dir), { executor: command, ...options });
}
const flow = JSON.stringify;

test('parallel writes replace previous iterations without merging sibling snapshots', async t => {
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-parallel/FLOW.json': flow({ type: 'parallel' }),
    '1.1-loop/1.1.1-parallel/1.1.1.1-nested/FLOW.json': flow({ type: 'parallel' }),
    '1.1-loop/1.1.1-parallel/1.1.1.1-nested/1.1.1.1.1-a.md': 'DELAY_150 OUTPUT::a',
    '1.1-loop/1.1.1-parallel/1.1.1.2-b.md': 'OUTPUT::b',
    '1.1-loop/1.1.2-gate.md': 'RETRY_ONCE {{ steps["1.1.1.1.1"].output }} {{ steps["1.1.1.2"].output }}',
    '1.2-final.md': 'OUTPUT::{{ steps["1.1.1.1.1"].artifact }} {{ steps["1.1.1.2"].artifact }}',
  });
  const result = await run(dir);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.error));
  assert.equal(result.steps['1.1.1.1.1'].attempts, 2);
  assert.equal(result.steps['1.1.1.2'].attempts, 2);
  const output = await readFile(result.steps['1.2'].artifact, 'utf8');
  assert.match(output, /1-1-1-1-1-attempt-2.md/);
  assert.match(output, /1-1-1-2-attempt-2.md/);
  assert.equal(result.events.filter(e => e.type === 'PARALLEL_JOIN').length, 4);
});

test('parallel siblings cannot see each other before join', async t => {
  const dir = await fixture(t, {
    '1.1-parallel/FLOW.json': flow({ type: 'parallel' }),
    '1.1-parallel/1.1.1-a.md': 'OUTPUT::a',
    '1.1-parallel/1.1.2-b.md': '{{ steps["1.1.1"].output }}',
  });
  const result = await run(dir);
  assert.equal(result.error.code, 'MISSING_REFERENCE');
  assert.equal(result.steps['1.1.1'].status, 'COMPLETED');
  assert.equal(result.steps['1.1.2'].status, 'FAILED');
  assert.ok(!result.events.some(e => e.type === 'PARALLEL_JOIN'));
});

test('join still rejects genuine duplicate branch writes', async t => {
  const dir = await fixture(t, { '1.1-a.md': 'OUTPUT::a', '1.2-b.md': 'OUTPUT::b' });
  const tree = await discoverWorkflow(dir);
  // Discovery normally rejects duplicates; exercise the runtime guard directly.
  tree.type = 'parallel';
  tree.children[1].id = tree.children[0].id;
  const result = await startRun(await loadEntry(dir), tree, { executor: command });
  assert.equal(result.error.code, 'PARALLEL_COLLISION');
});

test('template data is never reinterpreted and escaped literals render once', () => {
  const data = 'Hi {{first_name}}, use ${{ secrets.X }} / {{ input.missing }} / \\{{';
  const context = { input: { mail: data }, steps: { '1.1': { output: data, artifact: '/tmp/{{artifact}}' } } };
  assert.equal(renderTemplate('{{ input.mail }}', context), data);
  assert.equal(renderTemplate('{{ steps["1.1"].output }}', context), data);
  assert.equal(renderTemplate("{{ steps['1.1'].artifact }}", context), '/tmp/{{artifact}}');
  assert.equal(renderTemplate('Literal \\{{ input.missing }} and $\\{{ secrets.X }}', context), 'Literal {{ input.missing }} and ${{ secrets.X }}');
  assert.equal(renderTemplate('\\{{ and {{ input.mail }}', context), '{{ and ' + data);
  for (const source of ['{{ nope }}', '{{ input.mail', '{{ }}', '{{ steps["1.1\'].output }}']) {
    assert.throws(() => renderTemplate(source, context), { code: 'INVALID_TEMPLATE' });
  }
});

test('command inference, multiline --var, and braces round-trip through CLI and ENTRY', async t => {
  const dir = await fixture(t, {
    'ENTRY.md': 'Audience: {{ input.mail }}; literal \\{{ audience }}',
    '1.1-copy.md': '{{ input.mail }}',
    '1.2-consume.md': '{{ steps["1.1"].output }}',
  }, { executor: { type: 'echo' } });
  const value = 'Hi {{first_name}}\n${{ secrets.X }}\r\n你好';
  const result = await cli(['run', dir, '--command', process.execPath, '--arg', '-e', '--arg', 'process.stdin.pipe(process.stdout)', '--var', `mail=${value}`]);
  assert.equal(result.code, 0, result.output);
  const runId = /Run: (\S+)/.exec(result.output)[1];
  const state = JSON.parse((await cli(['inspect', runId], dir)).output);
  assert.equal(state.executor.type, 'command');
  const output = await readFile(state.steps['1.2'].artifact, 'utf8');
  assert.ok(output.includes(value));
  assert.ok(output.includes('literal {{ audience }}'));
  assert.ok(!output.includes('{{ input.mail }}'));
  assert.equal(parseArgs(['run', dir, '--var', 'mail=']).flags.input.mail, '');
  await assert.rejects(cli(['run', dir, '--executor', 'echo', '--command', 'node']), { code: 'CLI_USAGE' });
  await assert.rejects(cli(['run', dir, '--arg', '-p']), { code: 'CLI_USAGE' });
});

test('validate rejects invalid source syntax in ENTRY, prompts, and control expressions', async t => {
  for (const files of [
    { 'ENTRY.md': '{{ audience }}', '1.1-a.md': 'a' },
    { '1.1-a.md': 'a', '1.2-b.md': '{{ input.broken' },
    { '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ bad }}', equals: 'PASS', maxIterations: 1 }), '1.1-loop/1.1.1-a.md': 'a' },
  ]) {
    const dir = await fixture(t, files);
    await assert.rejects(cli(['validate', dir]), { code: 'INVALID_TEMPLATE' });
    await assert.rejects(cli(['run', dir]), { code: 'INVALID_TEMPLATE' });
    await assert.rejects(readdir(path.join(dir, '.awe')), { code: 'ENOENT' });
  }
});

test('executor argument values are omitted from state and prompts are opt-in', async t => {
  const dir = await fixture(t, { '1.1-a.md': 'OUTPUT::ok' });
  const result = await cli(['run', dir, '--command', process.execPath, '--arg', agent, '--arg', '--api-key=sk-test-SECRET', '--arg', '--token', '--arg', 'OTHER_SECRET']);
  assert.equal(result.code, 0);
  const runId = /Run: (\S+)/.exec(result.output)[1];
  const state = (await cli(['inspect', runId], dir)).output;
  assert.ok(!state.includes('SECRET'));
  assert.ok(!state.includes('argv'));
  const artifacts = await readdir(path.join(dir, '.awe/runs', runId, 'artifacts'));
  assert.equal(artifacts.length, 1);
  const stored = await fixture(t, { '1.1-a.md': 'OUTPUT::ok' }, { storePrompts: true });
  const runState = await run(stored);
  const prompt = await readFile(runState.steps['1.1'].prompt, 'utf8');
  assert.match(prompt, /# Workflow instructions \(ENTRY.md\)\n# Instructions/);
  assert.match(prompt, /OUTPUT::ok/);
});

test('gate normalization is opt-in and strict IF rejects unexpected tokens', async t => {
  for (const [config, verdict, expected] of [
    [{}, '**PASS**\nReason', 'no'],
    [{ match: 'first-line' }, '**PASS**\nReason', 'yes'],
    [{ match: 'first-line', caseInsensitive: true }, '`pass`\nReason', 'yes'],
    [{ match: 'first-line', elseEquals: 'FAIL' }, '**FAIL**\nReason', 'no'],
    [{ match: 'first-line', elseEquals: 'FAIL' }, 'MAYBE', 'IF_NO_MATCH'],
  ]) {
    const dir = await fixture(t, {
      '1.1-if/FLOW.json': flow({ type: 'if', test: '{{ input.verdict }}', equals: 'PASS', then: 'yes', else: 'no', ...config }),
      '1.1-if/yes/1.1.1-yes.md': 'OUTPUT::yes',
      '1.1-if/no/1.1.2-no.md': 'OUTPUT::no',
    });
    const result = await run(dir, { input: { verdict } });
    if (expected === 'IF_NO_MATCH') assert.equal(result.error.code, expected);
    else assert.equal(result.events.find(e => e.type === 'IF_BRANCH').branch, expected);
  }
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ input.verdict }}', equals: 'PASS', maxIterations: 1, match: 'first-line' }),
    '1.1-loop/1.1.1-a.md': 'OUTPUT::ok',
  });
  assert.equal((await run(dir, { input: { verdict: '**PASS**\nReason' } })).status, 'COMPLETED');
});

// A real wrapper with a grandchild keeps both processes alive and their stdio open.
const wrapper = `const {spawn}=require('node:child_process');
spawn(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync('ready','yes');setInterval(()=>fs.appendFileSync('heartbeat','x'),20)"], {stdio:'inherit'});
setInterval(()=>{},1000);`;
async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for executor readiness');
}
async function exists(file) {
  try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function assertHeartbeatStopped(dir) {
  await delay(60);
  const before = await readFile(path.join(dir, 'heartbeat'), 'utf8').catch(() => '');
  await delay(120);
  const after = await readFile(path.join(dir, 'heartbeat'), 'utf8').catch(() => '');
  assert.equal(after, before, 'grandchild must stop writing');
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} interrupts parallel steps, saves terminal state, and kills descendants`, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
    const dir = await fixture(t, {
      '1.1-parallel/FLOW.json': flow({ type: 'parallel' }),
      '1.1-parallel/1.1.1-a.md': 'wait',
      '1.1-parallel/1.1.2-b.md': 'wait',
    }, { executor: { type: 'command', argv: [process.execPath, '-e', wrapper], timeoutMs: 5000 } });
    const child = spawn(process.execPath, [path.join(root, 'bin/awe.js'), 'run', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    await waitFor(async () => {
      if (!await exists(path.join(dir, 'ready'))) return false;
      const [id] = await readdir(path.join(dir, '.awe/runs'));
      const state = JSON.parse(await readFile(path.join(dir, '.awe/runs', id, 'state.json'), 'utf8'));
      return Object.keys(state.steps).length === 2;
    });
    child.kill(signal);
    assert.equal(await closed, signal === 'SIGINT' ? 130 : 143);
    assert.match(stdout, /Status: INTERRUPTED/);
    const [id] = await readdir(path.join(dir, '.awe/runs'));
    const state = JSON.parse(await readFile(path.join(dir, '.awe/runs', id, 'state.json'), 'utf8'));
    assert.equal(state.status, 'INTERRUPTED');
    assert.ok(state.finishedAt);
    assert.equal(state.error.code, 'RUN_INTERRUPTED');
    assert.ok(Object.values(state.steps).every(step => step.status === 'INTERRUPTED'));
    await assertHeartbeatStopped(dir);
  });
}

test('timeout kills a wrapper and its grandchild', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const dir = await fixture(t, { '1.1-a.md': 'wait' });
  const result = await run(dir, { executor: { type: 'command', argv: [process.execPath, '-e', wrapper], timeoutMs: 1200 } });
  assert.equal(result.error.code, 'EXECUTOR_TIMEOUT');
  assert.equal(await exists(path.join(dir, 'ready')), true, 'grandchild must have started before timeout');
  await assertHeartbeatStopped(dir);
});

test('missing CLI option values cannot silently select echo', () => {
  for (const flag of ['--command', '--arg', '--executor', '--var', '--step']) {
    assert.throws(() => parseArgs(['run', '.', flag]), { code: 'CLI_USAGE' });
  }
  assert.throws(() => parseArgs(['run', '.', '--command', '']), { code: 'CLI_USAGE' });
});

test('invalid gate settings are rejected during discovery', async t => {
  for (const config of [{ match: 'fuzzy' }, { caseInsensitive: 'yes' }, { elseEquals: false }]) {
    const dir = await fixture(t, {
      '1.1-if/FLOW.json': flow({ type: 'if', test: 'PASS', equals: 'PASS', then: 'yes', else: 'no', ...config }),
      '1.1-if/yes/1.1.1-a.md': 'a',
      '1.1-if/no/1.1.2-b.md': 'b',
    });
    await assert.rejects(cli(['validate', dir]), { code: 'INVALID_FLOW' });
  }
});

test('a signal already aborted before a run creates a terminal trace without executing steps', async t => {
  const dir = await fixture(t, { '1.1-a.md': 'OUTPUT::unexpected' });
  const controller = new AbortController();
  controller.abort();
  const state = await run(dir, { signal: controller.signal });
  assert.equal(state.status, 'INTERRUPTED');
  assert.deepEqual(state.steps, {});
  assert.ok(state.finishedAt);
  assert.equal(state.events.at(-1).type, 'RUN_INTERRUPTED');
});
