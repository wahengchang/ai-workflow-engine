import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspace, put, run, calls, countByStep, agentCommand } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';
import { normalizeConfig, resolveExecutor } from '../src/config.js';

const steps = {
  '1.1-a.md': 'OUTPUT::a#{n}',
  '1.2-b.md': 'A={{ steps["1.1"].output }}\nOUTPUT::b#{n}',
  '1.3-c.md': 'OUTPUT::c#{n}',
};

test('run prints the cache mode, one line per step, the counts and a next step', async t => {
  const ws = await workspace(t, steps);
  const first = (await cli(['run', ws.dir, '1.1'], ws.dir)).output;
  assert.match(first, /^Workflow {2}\S+ \(3 steps\) {4}Executor {2}\S*node\S* … …$/m, 'arguments other than plain flags are hidden');
  assert.match(first, /^Cache {5}on — upstream reused, 1\.1 always runs \(--no-cache reruns everything\)$/m);
  assert.match(first, /^ {2}1\.1 +ran +\S+ +-> \.awe[\\/]runs[\\/]/m);
  assert.match(first, /Reused 0 steps · Ran 1 step/);
  assert.match(first, /^Next {2}awe show 1\.1 {3}· {3}awe run 1\.2$/m);

  const second = (await cli(['run', ws.dir, '1.2'], ws.dir)).output;
  assert.match(second, /^ {2}1\.1 +cached +\d\d:\d\d$/m);
  assert.match(second, /^ {2}1\.2 +ran /m);
  assert.match(second, /Reused 1 step · Ran 1 step/);

  const full = (await cli(['run', ws.dir], ws.dir)).output;
  assert.match(full, /^Cache {5}off — full run from the first step \(--cache reuses valid steps\)$/m);
  assert.match(full, /Reused 0 steps · Ran 3 steps/);
  assert.match(full, /^Next {2}awe show {3}· {3}awe show <step>$/m);

  const resumed = (await cli(['run', ws.dir, '--cache'], ws.dir)).output;
  assert.match(resumed, /Cache {5}on — valid steps are reused/);
  assert.match(resumed, /Reused 3 steps · Ran 0 steps/);
  assert.match((await cli(['run', ws.dir, '1.3', '--no-cache'], ws.dir)).output, /Cache {5}off — everything up to 1\.3 reruns \(--cache reuses valid upstream\)/);
  assert.match((await cli(['run', ws.dir, '1.3'], ws.dir)).output, /^Next {2}awe show 1\.3$/m, 'no next step after the last one');
});

test('a failing step shows the reason, the last stderr lines and the command to look closer', async t => {
  const ws = await workspace(t, { 'block.flag': 'x', '1.1-a.md': 'OUTPUT::a', '1.2-b.md': 'FAIL_IF_EXISTS::block.flag\nOUTPUT::b' });
  const result = await cli(['run', ws.dir], ws.dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /^ {2}1\.2 +FAILED +Command exited 3: blocked by block\.flag$/m);
  assert.match(result.output, /^ {10}blocked by block\.flag$/m, 'stderr tail is printed under the step');
  assert.match(result.output, /^Next {2}awe show 1\.2 --err {3}· {3}awe run 1\.2$/m);
  assert.equal((await cli(['show', ws.dir, '1.2', '--err'])).output, 'blocked by block.flag');
  assert.match((await cli(['show', ws.dir])).output, /Status {2}FAILED — EXECUTOR_FAILED: Command exited 3/);
  assert.match((await cli(['show', ws.dir])).output, /stderr \(last lines of 1\.2\):/);
});

test('a timeout names the limit, keeps stderr and suggests a longer --timeout', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'SLEEP::3000\nOUTPUT::a' }, { timeout: 0.3 });
  const result = await cli(['run', ws.dir], ws.dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /Command timed out after 0\.3s\. Raise it with --timeout <seconds> or "timeout" in awe\.json\./);
  assert.match(result.output, /run again with --retry 1\.1\./, 'the message itself says how to continue');
  assert.match(result.output, /^Next {2}awe run 1\.1 --timeout 1 --retry 1\.1 {4}\(limit now 0\.3s\) {3}· {3}awe show 1\.1 --err$/m);
  // The suggested command really works (no UNKNOWN_EFFECT dead end).
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: (await import('../fixtures/helpers.mjs')).agentCommand(ws.log), timeout: 0.3 }));
  await put(ws.dir, '1.1-a.md', 'OUTPUT::a');
  const followed = await cli(['run', ws.dir, '1.1', '--timeout', '1', '--retry', '1.1'], ws.dir);
  assert.equal(followed.code, 0, followed.output);
  // --timeout beats awe.json
  const slow = await workspace(t, { '1.1-a.md': 'SLEEP::600\nOUTPUT::a' }, { timeout: 60 });
  const cut = await run(slow, ['--timeout', '0.2']);
  assert.equal(cut.error.code, 'EXECUTOR_TIMEOUT');
  // A timed-out command may have acted before it was killed, so awe will not resend it on its own.
  const refused = await run(slow);
  assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
  assert.match(refused.error.message, /run the same command again with --retry 1\.1/);
  assert.equal((await run(slow, ['--retry', '1.1'])).status, 'COMPLETED');
});

test('named executors: default, per step, per-step timeout, and the --executor override', async t => {
  const main = await workspace(t, steps);
  const other = path.join(os.tmpdir(), `${path.basename(main.dir)}.other.jsonl`);
  t.after(() => rm(other, { force: true }));
  await put(main.dir, 'awe.json', JSON.stringify({
    version: 2, run: agentCommand(main.log), timeout: 30,
    executors: { search: { run: agentCommand(other), timeout: 90 } },
    steps: { '1.2': { executor: 'search', timeout: 5 } },
  }));
  const state = await run(main);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.deepEqual(await countByStep(main.log), { '1.1': 1, '1.3': 1 });
  assert.deepEqual(await countByStep(other), { '1.2': 1 });
  assert.deepEqual(state.invocations.map(item => item.executor), ['run', 'search', 'run']);

  // The CLI flag wins over the per-step setting.
  const forced = await run(main, ['--executor', 'search']);
  assert.deepEqual(forced.invocations.map(item => item.executor), ['search', 'search', 'search']);
  await assert.rejects(run(main, ['--executor', 'nope']), { code: 'UNKNOWN_EXECUTOR', message: /Unknown executor "nope"\. Available: run, search/ });
  await assert.rejects(cli(['run', main.dir, '--executor'], main.dir), { code: 'CLI_USAGE', message: /--executor needs a value.*Available: run, search/s });

  // A changed command line for one step only invalidates that step (and what follows it).
  const base = { version: 2, run: agentCommand(main.log), executors: { search: { run: agentCommand(other) } }, steps: { '1.2': { executor: 'search' } } };
  await put(main.dir, 'awe.json', JSON.stringify(base));
  assert.equal((await run(main)).status, 'COMPLETED');
  await put(main.dir, 'awe.json', JSON.stringify({
    version: 2, run: agentCommand(main.log),
    executors: { search: { run: agentCommand(other, ['--model', 'bigger']) } },
    steps: { '1.2': { executor: 'search' } },
  }));
  const next = await run(main, ['--cache']);
  assert.deepEqual([next.executed, next.reused], [2, 1]);
});

test('executor settings are validated with messages that say what to write', () => {
  const settings = config => normalizeConfig({ version: 2, ...config });
  const settingsError = (config, pattern) => assert.throws(() => settings(config), error => error.code === 'INVALID_CONFIG' && pattern.test(error.message), JSON.stringify(config));
  settingsError({ run: '' }, /empty.*claude -p \{prompt\}/);
  settingsError({ run: 5 }, /command string/);
  settingsError({ timeout: 0 }, /positive number of seconds/);
  settingsError({ executors: { run: 'x' } }, /may not be "run"/);
  settingsError({ executors: { a: { run: 'x', model: 'y' } } }, /unsupported key "model"\. Supported: run, timeout/);
  settingsError({ steps: { '1.1': { executor: 'ghost' } } }, /"ghost" is not defined\. Available: run/);
  settingsError({ steps: { '1.1': { timeout: -1 } } }, /steps\["1\.1"\]\.timeout/);

  const full = settings({ run: 'a -p {prompt}', timeout: 10, executors: { b: { run: 'b {prompt_file}', timeout: 20 } }, steps: { '1.2': { executor: 'b' }, '1.3': { timeout: 99 } } });
  assert.equal(resolveExecutor(full, '1.1').display, 'a -p {prompt}');
  assert.equal(resolveExecutor(full, '1.1').timeoutMs, 10000);
  assert.deepEqual([resolveExecutor(full, '1.2').name, resolveExecutor(full, '1.2').timeoutMs], ['b', 20000]);
  assert.equal(resolveExecutor(full, '1.3').timeoutMs, 99000);
  assert.equal(resolveExecutor(full, '1.3', { timeoutSeconds: 1.5 }).timeoutMs, 1500);
  assert.equal(resolveExecutor(full, '1.1', { executor: 'b' }).name, 'b');
  assert.equal(resolveExecutor(settings({ run: 'x' }), '1.1').timeoutMs, 300000, 'default limit is 5 minutes');
  assert.throws(() => resolveExecutor(settings({}), '1.1'), { code: 'NO_EXECUTOR', message: /awe run --dry[\s\S]*codex exec/ });
});

test('the legacy executor block still works, warns once, and never silently falls back to echo', async t => {
  const ws = await workspace(t, steps);
  await writeFile(path.join(ws.dir, 'awe.json'), JSON.stringify({ executor: { type: 'command', argv: [process.execPath, path.join(path.dirname(ws.dir), '..', 'nowhere.js')], timeoutMs: 4000 } }));
  const legacy = normalizeConfig({ executor: { type: 'command', argv: ['claude', '-p', 'x y'], timeoutMs: 4000 } });
  assert.equal(legacy.timeoutMs, 4000);
  assert.deepEqual(legacy.run.argv, ['claude', '-p', 'x y']);
  assert.match(legacy.warnings[0], /deprecated "executor" block\. Replace it with: "run": "claude -p \\"x y\\"", "timeout": 4/);

  const withLegacy = await workspace(t, steps, { run: undefined, executor: { type: 'command', argv: [process.execPath, path.join(process.cwd(), 'fixtures', 'agent.cjs')], timeoutMs: 4000 } });
  const result = await cli(['run', withLegacy.dir, '1.1'], withLegacy.dir);
  assert.equal(result.code, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /deprecated/);

  const echo = await workspace(t, steps, { run: undefined, executor: { type: 'echo' } });
  await assert.rejects(cli(['run', echo.dir], echo.dir), { code: 'NO_EXECUTOR', message: /removed echo executor.*awe run --dry/s });
  assert.equal((await cli(['run', echo.dir, '--dry'], echo.dir)).code, 0, 'a workflow that used echo can still be previewed');
});

test('--dry renders every prompt, calls nothing and writes nothing', async t => {
  const ws = await workspace(t, steps);
  const dry = await cli(['run', ws.dir, '--dry'], ws.dir);
  assert.equal(dry.code, 0);
  assert.match(dry.output, /^DRY RUN — 3 prompts rendered; nothing was executed, no AI calls, no cache written\./);
  assert.match(dry.output, /──── 1\.2 {2}1\.2-b\.md ────[\s\S]*A=\[output of 1\.1\]/);
  const one = await cli(['run', ws.dir, '1.3', '--dry'], ws.dir);
  assert.match(one.output, /DRY RUN — 1 prompt rendered/);
  assert.ok(!one.output.includes('──── 1.1'));
  await assert.rejects(cli(['run', ws.dir, '9.9', '--dry'], ws.dir), { code: 'STEP_NOT_FOUND' });
  assert.deepEqual(await calls(ws.log), []);
  const state = (await cli(['show', ws.dir]).catch(error => error));
  assert.equal(state.code, 'RUN_NOT_FOUND');
});

test('show: summary, a step output, prompt, errors and runs from other folders', async t => {
  const ws = await workspace(t, steps);
  await assert.rejects(cli(['show', ws.dir], ws.dir), { code: 'RUN_NOT_FOUND', message: /Nothing has run yet.*awe run --dry/s });
  await cli(['run', ws.dir, '1.2'], ws.dir);
  assert.equal((await cli(['show', ws.dir, '1.1'])).output, 'a#1', 'a step reused by the latest run is found in the earlier run');
  assert.equal((await cli(['show', ws.dir, '1.2'])).output, 'b#1');
  assert.match((await cli(['show', ws.dir, '1.2', '--prompt'])).output, /# Step 1\.2 .*\nA=a#1/s);
  assert.equal((await cli(['show', ws.dir, '1.2', '--err'])).output, '');
  assert.match((await cli(['show', ws.dir])).output, /^Run {5}\S+\nStatus {2}COMPLETED\nCache {3}on — upstream reused, 1\.2 always runs/);
  assert.equal(JSON.parse((await cli(['show', ws.dir, '1.2', '--json'])).output).step, '1.2');
  await assert.rejects(cli(['show', ws.dir, '1.3']), { code: 'STEP_NOT_FOUND', message: /no result yet.*Next: awe run 1\.3/s });
  await assert.rejects(cli(['show', ws.dir, '--run', 'nope']), { code: 'RUN_NOT_FOUND', message: /No run "nope"/ });
  await assert.rejects(cli(['show', ws.dir, '--prompt']), { code: 'CLI_USAGE', message: /needs a step/ });
  await assert.rejects(cli(['show', ws.dir, '1.2', '--prompt', '--err']), { code: 'CLI_USAGE' });

  const outside = await mkdtemp(path.join(os.tmpdir(), 'awe-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(cli(['show'], outside), { code: 'ENTRY_NOT_FOUND', message: /Not inside a workflow.*awe init <dir>/s });
  await assert.rejects(cli(['run', '1.1'], outside), { code: 'ENTRY_NOT_FOUND' });
});

test('check lists the plan and reports whether each executor exists', async t => {
  const ws = await workspace(t, steps);
  const ok = await cli(['check', ws.dir], ws.dir);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /^VALID .* \(3 prompt steps\)/);
  assert.match(ok.output, /prompt +1\.2 +1\.2-b\.md/);
  assert.match(ok.output, /^Executor {2}run: \S+ … …   \(found: \S+\)$/m, 'the executable path appears once');
  assert.match(ok.output, /Next {2}awe run --dry {3}· {3}awe run 1\.1/);

  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: 'awe-no-such-command-xyz -p {prompt}', executors: { other: 'ghost-cmd' }, steps: { '1.3': { executor: 'other' } } }));
  const bad = await cli(['check', ws.dir], ws.dir);
  assert.equal(bad.code, 0, 'a valid workflow passes; the executor problem is reported');
  assert.match(bad.output, /NOT READY — "awe-no-such-command-xyz" was not found on PATH/);
  assert.match(bad.output, /other: ghost-cmd {3}NOT READY/);
  assert.match(bad.output, /You can still preview prompts with: awe run --dry/);
  const json = JSON.parse((await cli(['check', ws.dir, '--json'], ws.dir)).output);
  assert.deepEqual(json.executors.map(item => [item.name, item.found]), [['run', null], ['other', null]]);
  assert.equal(json.ready, false);
  assert.equal(JSON.parse((await cli(['check', ws.dir, '--json'], ws.dir)).output).valid, true);
});

test('removed commands say what replaced them; help is available everywhere', async () => {
  for (const [old, replacement] of [['simulate', 'awe run --dry'], ['dev', 'awe run <step>'], ['validate', 'awe check'], ['plan', 'awe check'], ['status', 'awe show'], ['inspect', 'awe show <step>'], ['explain', 'awe show <step> --prompt']]) {
    await assert.rejects(cli([old, '.']), { code: 'CLI_USAGE', message: new RegExp(`awe ${old} was replaced by: ${replacement.replace(/[<>]/g, '.')}`) });
  }
  await assert.rejects(cli(['frobnicate']), { code: 'CLI_USAGE', message: /Unknown command "frobnicate"\. Commands: init, run, show, check/ });
  assert.match((await cli([])).output, /^awe — filesystem-first AI workflow engine/);
  assert.match((await cli(['run', '--help'])).output, /^Usage: awe run \[dir\] \[step\] \[flags\]/);
  assert.match((await cli(['show', '-h'])).output, /^Usage: awe show/);
  assert.match((await cli(['help', 'init'])).output, /^Usage: awe init <dir>/);
  for (const text of [(await cli(['--help'])).output]) {
    for (const flag of ['--var', '--cache', '--no-cache', '--dry', '--executor', '--timeout', '--retry', '--json']) assert.ok(text.includes(flag), `help documents ${flag}`);
  }
});

test('show follows a reused step to the run that produced it, and resolves LOOP occurrences', async t => {
  const ws = await workspace(t, steps);
  await cli(['run', ws.dir, '1.1'], ws.dir);
  await cli(['run', ws.dir, '1.2'], ws.dir); // 1.1 is only referenced here
  assert.match((await cli(['show', ws.dir, '1.1', '--prompt'])).output, /# Step 1\.1 /, 'the prompt of a cached step is found in the run that executed it');
  const json = JSON.parse((await cli(['show', ws.dir, '1.1', '--json'])).output);
  assert.equal(json.executor, 'run');
  assert.ok(json.prompt && json.reused);

  const loop = await workspace(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-draft.md': 'OUTPUT::draft#{n}',
    '1.1-loop/1.1.2-gate.md': 'PASS_IF_NUM_GTE::3::{{ steps["1.1.1"].output }}',
  });
  assert.equal((await run(loop)).status, 'COMPLETED');
  for (const n of [1, 2, 3]) assert.equal((await cli(['show', loop.dir, `1.1.1@${n}`])).output, `draft#${n}`);
  assert.equal((await cli(['show', loop.dir, '1.1.1'])).output, 'draft#3', 'without @ it is the latest occurrence');
  assert.match((await cli(['show', loop.dir, '1.1.1@2', '--prompt'])).output, /# Step 1\.1\.1 /);
  await assert.rejects(cli(['show', loop.dir, '1.1.1@9']), { code: 'STEP_NOT_FOUND', message: /No recorded occurrence 1\.1\.1@9\. Occurrences seen: 1\.1\.1@1, 1\.1\.1@2, 1\.1\.1@3/ });
});

test('a failing step with a prompt over 32 KB reports EXECUTOR_FAILED instead of crashing', async t => {
  const big = 'word '.repeat(9000);
  const ws = await workspace(t, { '1.1-big.md': `${big}\nFAIL_IF_EXISTS::block.flag\nOUTPUT::ok`, 'block.flag': 'x' });
  // Pass the prompt as an argument (the inline path), to a command that fails.
  await put(ws.dir, 'fail.cjs', "process.stderr.write('quota exceeded\\n'); process.exit(3);");
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: `${JSON.stringify(process.execPath)} fail.cjs {prompt}` }));
  const result = await cli(['run', ws.dir, '--json'], ws.dir);
  assert.equal(result.code, 1);
  const state = JSON.parse(result.output);
  assert.equal(state.error.code, 'EXECUTOR_FAILED');
  assert.match(state.error.message, /quota exceeded/);
  assert.ok(!state.error.message.includes('word word'), 'the prompt is still redacted from the message');
  // A plain non-zero exit is a known failure: the next run needs no --retry.
  await rm(path.join(ws.dir, 'block.flag'));
  const again = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
  assert.equal(again.error.code, 'EXECUTOR_FAILED');
});
