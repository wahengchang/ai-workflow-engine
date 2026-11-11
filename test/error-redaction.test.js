import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli } from '../src/cli.js';
import { executePrompt } from '../src/executor.js';

test('executor stderr cannot copy argument credentials into CLI output or persisted traces', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = ['sk-test-SECRET[a].*', 'private-token', '密碼🔐'];
  // A failing provider prints both full options and just their payloads.
  const program = `const args=process.argv.slice(1); process.stdin.resume(); process.stdin.on('end',()=>{process.stderr.write('Authentication failed: '+args.join(' ')+' '+args[0].split('=')[1]);process.exitCode=2;});`;
  const command = [process.execPath, '-e', program, '--', `--api-key=${secrets[0]}`, '--token', secrets[1], secrets[2]].map(token => JSON.stringify(token)).join(' ');
  await writeFile(path.join(dir, '1.1-run.md'), 'Run a command');
  await writeFile(path.join(dir, 'awe.json'), JSON.stringify({ version: 2, run: command }));
  const result = await cli(['run', dir, '--json']);
  assert.equal(result.code, 1);
  const state = JSON.parse(result.output);
  assert.equal(state.error.code, 'EXECUTOR_FAILED');
  assert.match(state.error.message, /Authentication failed/);
  assert.match(state.error.message, /\[REDACTED\]/);
  assert.match(state.error.stderrTail, /Authentication failed/);
  const saved = await readFile(path.join(dir, '.awe', 'runs', state.runId, 'state.json'), 'utf8');
  const text = (await cli(['run', dir])).output;
  for (const secret of secrets) {
    assert.ok(!result.output.includes(secret));
    assert.ok(!saved.includes(secret));
    assert.ok(!text.includes(secret), 'the readable summary and stderr excerpt are redacted too');
    assert.ok(!(await cli(['show', dir])).output.includes(secret));
    assert.ok(!(await cli(['show', dir, '1.1', '--err'])).output.includes(secret));
  }
});

test('redaction happens before truncation and handles overlapping values', async () => {
  const secret = 'unique-long-secret';
  const program = `process.stderr.write('x'.repeat(990)+process.argv[1]);process.exitCode=1`;
  await assert.rejects(executePrompt('input', { argv: [process.execPath, '-e', program, secret, 'long-secret'] }), error => {
    assert.equal(error.code, 'EXECUTOR_FAILED');
    assert.ok(!error.message.includes('unique-'));
    return true;
  });
});

test('UTF-8 split across process writes preserves output and redacts non-ASCII arguments', async () => {
  const value = '密碼🔐';
  const program = `const b=Buffer.from(process.argv[1]);process.stdout.write(b.subarray(0,1));process.stderr.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write(b.subarray(1));process.exitCode=1;},30)`;
  await assert.rejects(executePrompt('input', { argv: [process.execPath, '-e', program, value] }), { code: 'EXECUTOR_FAILED', message: 'Command exited 1: [REDACTED]' });
  assert.equal(await executePrompt('input', { argv: [process.execPath, '-e', program.replace('process.exitCode=1', 'process.exitCode=0'), value] }), value);
});
