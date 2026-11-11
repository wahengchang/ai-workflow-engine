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
import { runWorkflow } from '../src/engine.js';
import { renderTemplate } from '../src/template.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const agent = path.join(root, 'fixtures/fake-agent.cjs');
const command = { name: 'run', argv: [process.execPath, agent], display: 'fake agent', timeoutMs: 5000 };
const quote = JSON.stringify;
async function fixture(t, files, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'awe.json': JSON.stringify({ common: '# Instructions', ...config }), ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}
async function run(dir, options = {}) {
  const { executor = command, ...rest } = options;
  return runWorkflow(await loadEntry(dir), await discoverWorkflow(dir), { resolveExecutor: () => executor, ...rest });
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
  const result = await runWorkflow(await loadEntry(dir), tree, { resolveExecutor: () => command });
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

test('the command string, multiline --var, and braces round-trip through CLI and the common text', async t => {
  const dir = await fixture(t, {
    '1.1-copy.md': '{{ input.mail }}',
    '1.2-consume.md': '{{ steps["1.1"].output }}',
  }, { version: 2, common: 'Audience: {{ input.mail }}; literal \\{{ audience }}', run: `${quote(process.execPath)} -e "process.stdin.pipe(process.stdout)"` });
  const value = 'Hi {{first_name}}\n${{ secrets.X }}\r\n你好';
  const result = await cli(['run', dir, '--var', `mail=${value}`, '--json']);
  assert.equal(result.code, 0, result.output);
  const state = JSON.parse(result.output);
  const output = await readFile(state.steps['1.2'].artifact, 'utf8');
  assert.ok(output.includes(value));
  assert.ok(output.includes('literal {{ audience }}'));
  assert.ok(!output.includes('{{ input.mail }}'));
  assert.equal(parseArgs(['run', dir, '--var', 'mail=']).flags.input.mail, '');
  assert.equal(parseArgs(['run', dir, '--var=mail=x']).flags.input.mail, 'x');
  for (const args of [['--command', 'node'], ['--arg', '-p'], ['--executor', 'command', '--command', 'node']]) {
    await assert.rejects(cli(['run', dir, ...args]), { code: 'CLI_USAGE' }, args.join(' '));
  }
  await assert.rejects(cli(['run', dir, '--executor', 'echo']), { code: 'UNKNOWN_EXECUTOR', message: /Available: run/ });
});

test('check and run reject invalid source syntax in the common text, prompts, and control expressions', async t => {
  for (const [files, config] of [
    [{ '1.1-a.md': 'a' }, { common: '{{ audience }}' }],
    [{ '1.1-a.md': 'a', '1.2-b.md': '{{ input.broken' }, {}],
    [{ '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ bad }}', equals: 'PASS', maxIterations: 1 }), '1.1-loop/1.1.1-a.md': 'a' }, {}],
  ]) {
    const dir = await fixture(t, files, config);
    await assert.rejects(cli(['check', dir]), { code: 'INVALID_TEMPLATE' });
    await assert.rejects(cli(['run', dir]), { code: 'INVALID_TEMPLATE' });
    await assert.rejects(readdir(path.join(dir, '.awe')), { code: 'ENOENT' });
  }
});

test('template errors name the file or step and line', async t => {
  const dir = await fixture(t, { '1.1-a.md': 'fine', '1.2-b.md': 'line one\nUse ${{ secrets.X }} here' });
  await assert.rejects(cli(['check', dir]), { code: 'INVALID_TEMPLATE', message: /1\.2-b\.md: .*line 2/ });
  const entryDir = await fixture(t, { '1.1-a.md': 'a' }, { common: '# x\n{{ name }}' });
  await assert.rejects(cli(['check', entryDir]), { code: 'INVALID_TEMPLATE', message: /"common" in awe\.json: .*line 2/ });
  const flowDir = await fixture(t, {
    '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ bad }}', equals: 'PASS', maxIterations: 1 }),
    '1.1-loop/1.1.1-a.md': 'a',
  });
  await assert.rejects(cli(['check', flowDir]), { code: 'INVALID_TEMPLATE', message: /1\.1-loop\/FLOW\.json \(until\)/ });
  const missing = await fixture(t, { '1.1-a.md': '{{ input.nope }}' });
  const result = await run(missing);
  assert.equal(result.error.code, 'MISSING_REFERENCE');
  assert.match(result.error.message, /1\.1-a\.md: Missing template value: input\.nope/);
});

test('executor argument values are omitted from state; prompts are kept as files unless storePrompts is false', async t => {
  const dir = await fixture(t, { '1.1-a.md': 'OUTPUT::ok' }, { version: 2, run: `${quote(process.execPath)} ${quote(agent)} "--api-key=sk-test-SECRET" --token OTHER_SECRET` });
  const result = await cli(['run', dir, '--json']);
  assert.equal(result.code, 0);
  const state = JSON.parse(result.output);
  const text = JSON.stringify(state) + (await cli(['show', dir, '--json'])).output;
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('argv'));
  assert.deepEqual((await readdir(path.join(dir, '.awe/runs', state.runId, 'artifacts'))).sort(), ['1-1-attempt-1.md', 'prompt-1-1-attempt-1.md']);
  const prompt = await readFile(state.steps['1.1'].prompt, 'utf8');
  assert.match(prompt, /^# Common instructions\n# Instructions\n\n# Step 1\.1 /);
  assert.match(prompt, /OUTPUT::ok/);
  assert.equal((await cli(['show', dir, '1.1', '--prompt'])).output, prompt.trimEnd());

  const quiet = await fixture(t, { '1.1-a.md': 'OUTPUT::ok' }, { version: 2, run: `${quote(process.execPath)} ${quote(agent)}`, storePrompts: false });
  const quietState = JSON.parse((await cli(['run', quiet, '--json'])).output);
  assert.deepEqual(await readdir(path.join(quiet, '.awe/runs', quietState.runId, 'artifacts')), ['1-1-attempt-1.md']);
  await assert.rejects(cli(['show', quiet, '1.1', '--prompt']), { code: 'PROMPT_NOT_STORED' });
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
const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
for (const signal of Object.keys(exitCodes)) {
  test(`${signal} interrupts parallel steps, saves terminal state, and kills descendants`, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
    const dir = await fixture(t, {
      '1.1-parallel/FLOW.json': flow({ type: 'parallel' }),
      '1.1-parallel/1.1.1-a.md': 'wait',
      '1.1-parallel/1.1.2-b.md': 'wait',
      'wrapper.cjs': wrapper,
    }, { version: 2, run: `${quote(process.execPath)} wrapper.cjs`, timeout: 5 });
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
    assert.equal(await closed, exitCodes[signal]);
    assert.match(stdout, /INTERRUPTED/);
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
  const result = await run(dir, { executor: { name: 'run', argv: [process.execPath, '-e', wrapper], timeoutMs: 1200 } });
  assert.equal(result.error.code, 'EXECUTOR_TIMEOUT');
  assert.equal(await exists(path.join(dir, 'ready')), true, 'grandchild must have started before timeout');
  await assertHeartbeatStopped(dir);
});

test('flags that need a value never swallow the next flag or run with a missing value', () => {
  for (const flag of ['--executor', '--var', '--timeout', '--retry']) {
    assert.throws(() => parseArgs(['run', '.', flag]), { code: 'CLI_USAGE' });
    assert.throws(() => parseArgs(['run', '.', flag, '--json']), { code: 'CLI_USAGE', message: new RegExp(`${flag} needs a value`) });
  }
  assert.throws(() => parseArgs(['run', '.', '--executor', '--cache']), { code: 'CLI_USAGE' });
  assert.throws(() => parseArgs(['run', '.', '--timeout', 'soon']), { code: 'CLI_USAGE', message: /positive number/ });
  assert.throws(() => parseArgs(['run', '.', '--bogus']), { code: 'CLI_USAGE', message: /Unknown flag --bogus for awe run\. Flags: /});
  assert.throws(() => parseArgs(['init']), { code: 'CLI_USAGE' });
  assert.throws(() => parseArgs(['simulate', '.']), { code: 'CLI_USAGE', message: /replaced by: awe run --dry/ });
  assert.deepEqual(parseArgs(['run', 'wf', '2.1.1@2.1', '--timeout', '600', '--no-cache']).step, '2.1.1@2.1');
  assert.equal(parseArgs(['run', '1.2']).dir, undefined, 'a step address is not a folder');
});

test('invalid gate settings are rejected during discovery', async t => {
  for (const config of [{ match: 'fuzzy' }, { caseInsensitive: 'yes' }, { elseEquals: false }]) {
    const dir = await fixture(t, {
      '1.1-if/FLOW.json': flow({ type: 'if', test: 'PASS', equals: 'PASS', then: 'yes', else: 'no', ...config }),
      '1.1-if/yes/1.1.1-a.md': 'a',
      '1.1-if/no/1.1.2-b.md': 'b',
    });
    await assert.rejects(cli(['check', dir]), { code: 'INVALID_FLOW' });
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
