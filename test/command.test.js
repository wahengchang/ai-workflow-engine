import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { splitCommand, displayCommand, usesPlaceholder } from '../src/command.js';
import { buildArgv, executePrompt, MAX_INLINE_PROMPT_BYTES, tailLines, needsPromptFile } from '../src/executor.js';

const node = process.execPath;

test('splitCommand splits like a shell would, without involving one', () => {
  assert.deepEqual(splitCommand('claude -p {prompt}'), ['claude', '-p', '{prompt}']);
  assert.deepEqual(splitCommand('  codex   exec  {prompt} '), ['codex', 'exec', '{prompt}']);
  assert.deepEqual(splitCommand(`agent --system "be brief" 'it''s' a\\ b`), ['agent', '--system', 'be brief', 'its', 'a b']);
  assert.deepEqual(splitCommand('agent "say \\"hi\\"" "back\\\\slash"'), ['agent', 'say "hi"', 'back\\slash']);
  assert.deepEqual(splitCommand('tool "" x'), ['tool', '', 'x'], 'an explicit empty argument survives');
  assert.deepEqual(splitCommand('C:\\tools\\agent.exe -p {prompt}'), ['C:\\tools\\agent.exe', '-p', '{prompt}'], 'Windows paths need no escaping');
  assert.deepEqual(splitCommand('a $(rm -rf /) `x` ; b | c > d'), ['a', '$(rm', '-rf', '/)', '`x`', ';', 'b', '|', 'c', '>', 'd'], 'shell syntax is inert');
  assert.throws(() => splitCommand('agent "unclosed'), { code: 'INVALID_CONFIG', message: /unclosed "/ });
  assert.throws(() => splitCommand('   '), { code: 'INVALID_CONFIG', message: /empty/ });
  assert.throws(() => splitCommand(['claude']), { code: 'INVALID_CONFIG' });
});

test('displayCommand shows the executable and plain flags, and hides everything else', () => {
  assert.equal(displayCommand(['claude', '-p', '{prompt}']), 'claude -p {prompt}');
  assert.equal(displayCommand(['codex', 'exec', '--skip-git-repo-check', '{prompt}']), 'codex exec --skip-git-repo-check {prompt}');
  assert.equal(displayCommand(['agent', '--api-key=sk-123', '--token', 'private-token']), 'agent … --token …');
});

test('{prompt} is inlined, {prompt_file} is a path, and long prompts become a pointer to the file', () => {
  assert.deepEqual(buildArgv(['a', '-p', '{prompt}'], 'hello', '/tmp/p.md'), ['a', '-p', 'hello']);
  assert.deepEqual(buildArgv(['a', '--file={prompt_file}'], 'hello', '/tmp/p.md'), ['a', '--file=/tmp/p.md']);
  assert.deepEqual(buildArgv(['a', '{prompt}', '{prompt_file}'], 'x', '/tmp/p.md'), ['a', 'x', '/tmp/p.md']);
  const long = 'x'.repeat(MAX_INLINE_PROMPT_BYTES + 1);
  assert.deepEqual(buildArgv(['a', '{prompt}'], long, '/tmp/p.md'), ['a', 'Read and follow the instructions in the file: /tmp/p.md']);
  assert.deepEqual(buildArgv(['a', '{prompt}'], 'a {prompt_file} b', '/tmp/p.md'), ['a', 'a {prompt_file} b'], 'inserted prompt text is never re-expanded');
  assert.equal(usesPlaceholder(['a', 'b']), false);
  assert.equal(needsPromptFile(['a', '{prompt}'], 'short'), false);
  assert.equal(needsPromptFile(['a', '{prompt}'], long), true);
  assert.equal(needsPromptFile(['a', '{prompt_file}'], 'short'), true);
  assert.equal(needsPromptFile(['a'], long), false, 'stdin has no size limit');
});

test('executePrompt: stdin by default, {prompt} as an argument, long prompts through a file', async t => {
  const echoArg = 'process.stdout.write(process.argv[1] ?? "")';
  assert.equal(await executePrompt('from stdin', { argv: [node, '-e', 'process.stdin.pipe(process.stdout)'] }), 'from stdin');
  assert.equal(await executePrompt('as argument', { argv: [node, '-e', echoArg, '{prompt}'] }), 'as argument');
  assert.equal(await executePrompt('$(echo no) `x` "quoted" \'single\'', { argv: [node, '-e', echoArg, '{prompt}'] }), '$(echo no) `x` "quoted" \'single\'', 'no shell, no interpretation');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prompt.md');
  const long = 'y'.repeat(MAX_INLINE_PROMPT_BYTES + 10);
  await writeFile(file, long);
  assert.equal(await executePrompt(long, { argv: [node, '-e', echoArg, '{prompt}'], promptFile: file }), `Read and follow the instructions in the file: ${file}`);
  const readFile = 'process.stdout.write(String(require("node:fs").readFileSync(process.argv[1], "utf8").length))';
  assert.equal(await executePrompt(long, { argv: [node, '-e', readFile, '{prompt_file}'], promptFile: file }), String(long.length));
  await assert.rejects(executePrompt(long, { argv: [node, '-e', echoArg, '{prompt}'] }), { code: 'INVALID_EXECUTOR', message: /prompt file/ });
});

test('stderr: the last lines are reported on success and attached to failures', async () => {
  const noisy = 'for (let i = 1; i <= 30; i++) console.error("line " + i); process.exitCode = Number(process.argv[1]);';
  let seen;
  assert.equal(await executePrompt('x', { argv: [node, '-e', noisy, '0'], onStderr: tail => { seen = tail; } }), '');
  assert.equal(seen.split('\n').length, 20);
  assert.ok(seen.startsWith('line 11') && seen.endsWith('line 30'));
  await assert.rejects(executePrompt('x', { argv: [node, '-e', noisy, '3'] }), error => {
    assert.equal(error.code, 'EXECUTOR_FAILED');
    assert.ok(error.stderrTail.endsWith('line 30'));
    return true;
  });
  assert.equal(tailLines('a\nb\n\n', 1), 'b');
});

test('timeouts name the limit and how to change it; a missing command says how to fix it', async () => {
  await assert.rejects(executePrompt('x', { argv: [node, '-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 200 }), { code: 'EXECUTOR_TIMEOUT', message: /timed out after 0\.2s.*--timeout <seconds>.*"timeout" in awe\.json/ });
  await assert.rejects(executePrompt('x', { argv: ['awe-no-such-command-xyz', '-p', '{prompt}'] }), { code: 'EXECUTOR_ERROR', message: /command not found.*awe check/ });
});
