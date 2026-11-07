import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cli } from '../src/cli.js';

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('content init creates a complete editable workflow that validates, plans and simulates', async t => {
  const dir = await workspace(t);
  const result = await cli(['init', '--template', 'content', '--out', 'nested/my workflow'], dir);
  assert.equal(result.code, 0);
  assert.match(result.output, /echo \(simulation; no AI calls\)/);
  const target = path.join(dir, 'nested/my workflow');
  assert.equal((await cli(['validate', target])).code, 0);
  const plan = JSON.parse((await cli(['plan', target, '--json'])).output);
  assert.equal(plan.filter(step => step.type === 'prompt').length, 6);
  const config = JSON.parse(await readFile(path.join(target, 'awe.json'), 'utf8'));
  assert.deepEqual(config.executor, { type: 'echo' });
  await assert.rejects(readdir(path.join(target, '.awe')), { code: 'ENOENT' });
  const state = JSON.parse((await cli(['simulate', target, '--var', 'topic=Test article', '--json'])).output);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.executionMode, 'SIMULATED');
  assert.equal(Object.keys(state.steps).length, 6);
  assert.match(await readFile(state.steps['1.1'].artifact, 'utf8'), /Test article/);
  assert.ok(state.events.some(event => event.type === 'PARALLEL_JOIN'));
});

test('init refuses existing files, empty directories and populated directories', async t => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, 'file'), 'keep');
  await mkdir(path.join(dir, 'empty'));
  await mkdir(path.join(dir, 'existing'));
  await writeFile(path.join(dir, 'existing/ENTRY.md'), 'keep instructions');
  for (const out of ['file', 'empty', 'existing']) {
    await assert.rejects(cli(['init', '--out', out], dir), { code: 'INIT_EXISTS' });
  }
  assert.equal(await readFile(path.join(dir, 'file'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(path.join(dir, 'empty')), []);
  assert.equal(await readFile(path.join(dir, 'existing/ENTRY.md'), 'utf8'), 'keep instructions');
});

test('invalid init arguments fail without creating a destination', async t => {
  const dir = await workspace(t);
  for (const args of [[], ['--out'], ['--out', ''], ['--template', 'unknown', '--out', 'new'], ['--out', 'new', '--force'], ['--out', '--template', 'content'], ['--out', 'new', '--out', 'other']]) {
    await assert.rejects(cli(['init', ...args], dir), { code: 'CLI_USAGE' });
  }
  assert.deepEqual(await readdir(dir), []);
});


test('init refuses a symlink without changing its destination', { skip: process.platform === 'win32' }, async t => {
  const dir = await workspace(t);
  await mkdir(path.join(dir, 'real'));
  await writeFile(path.join(dir, 'real/ENTRY.md'), 'keep');
  await symlink(path.join(dir, 'real'), path.join(dir, 'alias'));
  await assert.rejects(cli(['init', '--out', 'alias'], dir), { code: 'INIT_EXISTS' });
  assert.equal(await readFile(path.join(dir, 'real/ENTRY.md'), 'utf8'), 'keep');
});
