import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cli } from '../src/cli.js';

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const noAgents = { PATH: '' };

test('content init creates a complete editable workflow that checks and previews', async t => {
  const dir = await workspace(t);
  const result = await cli(['init', 'nested/my workflow'], dir, { env: noAgents });
  assert.equal(result.code, 0);
  assert.match(result.output, /Executor  none found on PATH/);
  const target = path.join(dir, 'nested/my workflow');
  const checked = await cli(['check', target]);
  assert.match(checked.output, /VALID/);
  assert.equal(checked.code, 0, 'the workflow is valid; the missing executor is reported, not fatal');
  assert.match(checked.output, /NOT CONFIGURED/);
  const plan = JSON.parse((await cli(['check', target, '--json'])).output).plan;
  assert.equal(plan.filter(step => step.type === 'prompt').length, 6);
  const config = JSON.parse(await readFile(path.join(target, 'awe.json'), 'utf8'));
  assert.equal(config.version, 2);
  assert.equal(config.run, undefined);
  assert.equal(config.executor, undefined);
  await assert.rejects(readdir(path.join(target, '.awe')), { code: 'ENOENT' });
  const dry = await cli(['run', target, '--dry', '--var', 'topic=Test article']);
  assert.equal(dry.code, 0);
  assert.match(dry.output, /DRY RUN — 6 prompts rendered/);
  assert.match(dry.output, /Test article/);
  await assert.rejects(readdir(path.join(target, '.awe')), { code: 'ENOENT' }, '--dry writes nothing');
  await assert.rejects(cli(['run', target]), { code: 'NO_EXECUTOR', message: /awe run --dry[\s\S]*"run": "claude -p \{prompt\}"/ });
});

test('init writes the first AI CLI found on PATH into awe.json', { skip: process.platform === 'win32' && 'needs executable scripts' }, async t => {
  const dir = await workspace(t);
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  for (const name of ['opencode', 'codex']) {
    await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, name), 0o755);
  }
  const result = await cli(['init', 'wf'], dir, { env: { PATH: bin } });
  assert.match(result.output, /Executor  codex exec \{prompt\}   \(found codex on PATH/);
  const config = JSON.parse(await readFile(path.join(dir, 'wf/awe.json'), 'utf8'));
  assert.equal(config.run, 'codex exec {prompt}');
  assert.equal(config.version, 2);
  assert.equal(config.input.topic, 'How to choose coffee beans');
});

test('init refuses existing files, empty directories and populated directories', async t => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, 'file'), 'keep');
  await mkdir(path.join(dir, 'empty'));
  await mkdir(path.join(dir, 'existing'));
  await writeFile(path.join(dir, 'existing/awe.json'), 'keep instructions');
  for (const out of ['file', 'empty', 'existing']) {
    await assert.rejects(cli(['init', out], dir), { code: 'INIT_EXISTS' });
  }
  assert.equal(await readFile(path.join(dir, 'file'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(path.join(dir, 'empty')), []);
  assert.equal(await readFile(path.join(dir, 'existing/awe.json'), 'utf8'), 'keep instructions');
});

test('invalid init arguments fail without creating a destination', async t => {
  const dir = await workspace(t);
  for (const args of [[], ['--out', 'new'], ['new', '--force'], ['new', 'other'], ['--template', 'content', 'new']]) {
    await assert.rejects(cli(['init', ...args], dir), { code: 'CLI_USAGE' }, args.join(' '));
  }
  assert.deepEqual(await readdir(dir), []);
});

test('init refuses a symlink without changing its destination', { skip: process.platform === 'win32' }, async t => {
  const dir = await workspace(t);
  await mkdir(path.join(dir, 'real'));
  await writeFile(path.join(dir, 'real/awe.json'), 'keep');
  await symlink(path.join(dir, 'real'), path.join(dir, 'alias'));
  await assert.rejects(cli(['init', 'alias'], dir), { code: 'INIT_EXISTS' });
  assert.equal(await readFile(path.join(dir, 'real/awe.json'), 'utf8'), 'keep');
});
