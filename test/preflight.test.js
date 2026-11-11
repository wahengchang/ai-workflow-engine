import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli } from '../src/cli.js';

async function fixture(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-preflight-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ 'awe.json': JSON.stringify({ version: 2, common: '# Instructions' }), ...files })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), source);
  }
  return dir;
}

test('unknown, forward and common-text step references fail before creating any run', async t => {
  for (const files of [
    { '1.1-a.md': 'a', '1.2-b.md': '{{ steps["9.9"].output }}' },
    { '1.1-a.md': '{{ steps["1.2"].output }}', '1.2-b.md': 'b' },
    { 'awe.json': JSON.stringify({ version: 2, common: '{{ steps["1.1"].artifact }}' }), '1.1-a.md': 'a' },
  ]) {
    const dir = await fixture(t, files);
    for (const args of [['check'], ['run'], ['run', '--dry']]) {
      await assert.rejects(cli([args[0], dir, ...args.slice(1)]), { code: 'MISSING_REFERENCE', message: /not guaranteed/ });
    }
    await assert.rejects(readdir(path.join(dir, '.awe')), { code: 'ENOENT' });
  }
});

test('parallel siblings are isolated while joined outputs are available downstream', async t => {
  const dir = await fixture(t, {
    '1.1-par/FLOW.json': '{"type":"parallel"}',
    '1.1-par/1.1.1-a.md': 'a',
    '1.1-par/1.1.2-b.md': 'b',
    '1.2-final.md': '{{ steps["1.1.1"].output }} {{ steps["1.1.2"].artifact }}',
  });
  assert.equal((await cli(['run', dir, '--dry'])).code, 0);
  await writeFile(path.join(dir, '1.1-par/1.1.2-b.md'), '{{ steps["1.1.1"].output }}');
  await assert.rejects(cli(['check', dir]), { code: 'MISSING_REFERENCE', message: /1\.1\.2-b\.md/ });
});

test('conditional outputs cannot escape an IF and its gate requires upstream values', async t => {
  const dir = await fixture(t, {
    '1.1-if/FLOW.json': JSON.stringify({ type: 'if', test: '{{ input.route }}', equals: 'yes', then: 'yes', else: 'no' }),
    '1.1-if/yes/1.1.1-a.md': 'a',
    '1.1-if/no/1.1.2-b.md': 'b',
    '1.2-final.md': '{{ steps["1.1.1"].output }}',
  });
  await assert.rejects(cli(['check', dir]), { code: 'MISSING_REFERENCE', message: /1\.2-final/ });
  await writeFile(path.join(dir, '1.2-final.md'), 'final');
  await writeFile(path.join(dir, '1.1-if/FLOW.json'), JSON.stringify({ type: 'if', test: '{{ steps["1.1.1"].output }}', equals: 'yes', then: 'yes', else: 'no' }));
  await assert.rejects(cli(['check', dir]), { code: 'MISSING_REFERENCE', message: /FLOW.json \(test\)/ });
});

test('loop gate sees body results, but first iteration cannot read future feedback', async t => {
  const dir = await fixture(t, {
    '1.1-loop/FLOW.json': JSON.stringify({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 2 }),
    '1.1-loop/1.1.1-draft.md': 'draft',
    '1.1-loop/1.1.2-review.md': '{{ steps["1.1.1"].output }}',
    '1.2-final.md': '{{ steps["1.1.2"].output }}',
  });
  assert.match((await cli(['check', dir])).output, /VALID/);
  await writeFile(path.join(dir, '1.1-loop/1.1.1-draft.md'), '{{ steps["1.1.2"].output }}');
  await assert.rejects(cli(['check', dir]), { code: 'MISSING_REFERENCE' });
});

test('input supplied later and escaped reference examples do not fail structural checks', async t => {
  const dir = await fixture(t, { '1.1-a.md': '{{ input.topic }} \\{{ steps["9.9"].output }}' });
  assert.match((await cli(['check', dir])).output, /VALID/);
  assert.equal((await cli(['run', dir, '--dry', '--var', 'topic={{ steps["9.9"].output }}'])).code, 0);
});
