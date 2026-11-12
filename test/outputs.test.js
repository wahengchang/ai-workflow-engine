import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspace, put, run, resume, calls, countByStep, flow } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';

const PDF_HEX = Buffer.from('%PDF-1.4 fake').toString('hex');
const declare = (id, ...outputs) => ({ steps: { [id]: { outputs } } });
const report = { name: 'report', path: 'out/report.pdf' };
const makePdf = `WRITEBYTES::out/report.pdf::${PDF_HEX}\nOUTPUT::made`;
const validate = ws => cli(['check', ws.dir], ws.dir);

test('a declared PDF is saved per attempt and consumed by name downstream', async t => {
  const ws = await workspace(t, {
    '1.1-make.md': makePdf,
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }}\nOUTPUT::used',
  }, declare('1.1', report));
  const state = await resume(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const saved = state.steps['1.1'].files.report;
  assert.equal(saved.source, 'out/report.pdf');
  assert.ok(saved.path.startsWith(path.join(ws.dir, '.awe', 'runs', state.runId, 'artifacts', 'files', '1-1', 'attempt-1')));
  assert.ok(saved.path.endsWith('report.pdf'), 'the extension survives so viewers still open it');
  const bytes = await readFile(saved.path);
  assert.equal(bytes.toString(), '%PDF-1.4 fake');
  assert.equal(saved.size, bytes.length);
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o222, 0, 'the saved copy is read-only');
  assert.match((await calls(ws.log)).find(c => c.step === '1.2').prompt, new RegExp(`Attach ${saved.path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));

  // Later edits to the workspace file do not touch the saved copy or the cache.
  await writeFile(path.join(ws.dir, 'out/report.pdf'), 'changed after the fact');
  assert.equal((await readFile(saved.path)).toString(), '%PDF-1.4 fake');
  const again = await resume(ws);
  assert.deepEqual([again.executed, again.reused], [0, 2]);
  assert.equal(again.steps['1.1'].files.report.path, saved.path);
});

test('rerunning never overwrites an earlier copy, and downstream follows the newest', async t => {
  const ws = await workspace(t, {
    '1.1-make.md': 'WRITE::out/report.pdf::version {n}\nOUTPUT::made',
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }}\nOUTPUT::used',
  }, declare('1.1', report));
  const first = await run(ws, ['1.1']);
  const second = await run(ws, ['1.1']);
  const a = first.steps['1.1'].files.report.path;
  const b = second.steps['1.1'].files.report.path;
  assert.notEqual(a, b);
  assert.equal(await readFile(a, 'utf8'), 'version 1');
  assert.equal(await readFile(b, 'utf8'), 'version 2');
  const rest = await resume(ws);
  assert.equal(rest.status, 'COMPLETED');
  assert.ok((await calls(ws.log)).find(c => c.step === '1.2').prompt.includes(b));
});

test('attempts inside one run (LOOP iterations) get separate directories', async t => {
  const ws = await workspace(t, {
    '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-make.md': 'WRITE::out/draft.txt::draft {n}\nOUTPUT::made',
    // The gate passes once the saved path says attempt-2, which proves the loop reads the newest copy.
    '1.1-loop/1.1.2-gate.md': 'PASS_IF_NUM_GTE::2::{{ steps["1.1.1"].files["draft"] }}',
  }, declare('1.1.1', { name: 'draft', path: 'out/draft.txt' }));
  const result = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.error));
  const base = path.join(ws.dir, '.awe', 'runs', result.runId, 'artifacts', 'files', '1-1-1');
  assert.deepEqual((await readdir(base)).sort(), ['attempt-1', 'attempt-2']);
  assert.equal(await readFile(path.join(base, 'attempt-1', 'draft.txt'), 'utf8'), 'draft 1');
  assert.equal(await readFile(path.join(base, 'attempt-2', 'draft.txt'), 'utf8'), 'draft 2');
});

test('generated output folders do not break later workflow discovery', async t => {
  const ok = await workspace(t, {
    '1.1-make.md': `${makePdf}\nWRITE::notes.md::# generated notes\nWRITE::stage-9-misc/scratch/log.txt::x`,
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }} and {{ steps["1.1"].files["notes"] }}',
  }, declare('1.1', report, { name: 'notes', path: 'notes.md' }, { name: 'log', path: 'stage-9-misc/scratch/log.txt' }));
  assert.equal((await resume(ok)).status, 'COMPLETED');
  assert.ok((await readdir(ok.dir)).includes('out') && (await readdir(ok.dir)).includes('notes.md'), 'the executor really created them');
  assert.match((await cli(['check', ok.dir], ok.dir)).output, /1\.2/, 'plan still works with generated files present');
  assert.match((await validate(ok)).output, /VALID/);
  assert.equal((await resume(ok)).reused, 2);
});

test('a missing required output fails the attempt and leaves nothing reusable', async t => {
  const ws = await workspace(t, {
    '1.1-make.md': 'OUTPUT::forgot to write the file',
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }}\nOUTPUT::used',
  }, declare('1.1', report));
  const state = await resume(ws);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error.code, 'OUTPUT_MISSING');
  assert.equal(state.steps['1.1'].status, 'FAILED');
  const retry = await resume(ws);
  assert.equal(retry.error.code, 'OUTPUT_MISSING', 'the failed attempt is not a cache hit');
  assert.equal((await countByStep(ws.log))['1.2'], undefined);
  const prod = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
  assert.equal(prod.error.code, 'OUTPUT_MISSING');
  await put(ws.dir, '1.1-make.md', makePdf);
  assert.equal((await resume(ws)).status, 'COMPLETED');
});

test('a tampered or missing stored file invalidates the cache and the work is redone', async t => {
  const ws = await workspace(t, {
    '1.1-make.md': 'WRITE::out/report.pdf::version {n}\nOUTPUT::made',
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }}\nOUTPUT::used',
  }, declare('1.1', report));
  const first = await resume(ws);
  const saved = first.steps['1.1'].files.report.path;
  await chmod(saved, 0o644);
  await writeFile(saved, 'version 1 (edited)');
  const second = await resume(ws);
  assert.ok(second.events.some(e => e.type === 'CACHE_INVALID' && e.node === '1.1' && /file report: (size|digest) mismatch/.test(e.reason)));
  assert.deepEqual([second.executed, second.reused], [2, 0], 'downstream follows the redone step');
  assert.equal(await readFile(second.steps['1.1'].files.report.path, 'utf8'), 'version 2');

  const artifact = second.steps['1.2'].artifact;
  await writeFile(artifact, 'tampered text');
  const third = await resume(ws);
  assert.ok(third.events.some(e => e.type === 'CACHE_INVALID' && e.node === '1.2' && /artifact/.test(e.reason)));
  assert.deepEqual([third.executed, third.reused], [1, 1]);

  await chmod(third.steps['1.1'].files.report.path, 0o644);
  await writeFile(third.steps['1.1'].files.report.path, 'x'.repeat(100));
  const sizeChange = await resume(ws);
  assert.ok(sizeChange.events.some(e => e.type === 'CACHE_INVALID' && /size mismatch/.test(e.reason)));
  await (await import('node:fs/promises')).rm(sizeChange.steps['1.1'].files.report.path, { force: true });
  const gone = await resume(ws);
  assert.ok(gone.events.some(e => e.type === 'CACHE_INVALID' && /file report: missing/.test(e.reason)));
});

test('a file left in the workspace by an earlier attempt is not mistaken for this attempt output', async t => {
  const ws = await workspace(t, { '1.1-make.md': 'OUTPUT::wrote nothing' }, declare('1.1', report));
  await put(ws.dir, 'out/report.pdf', 'leftover from yesterday');
  const stale = await resume(ws);
  assert.equal(stale.status, 'FAILED');
  assert.equal(stale.error.code, 'OUTPUT_STALE');
  const prod = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
  assert.equal(prod.error.code, 'OUTPUT_STALE');
  // Rewriting the very same bytes is a real write and is accepted.
  await put(ws.dir, '1.1-make.md', 'WRITE::out/report.pdf::leftover from yesterday\nOUTPUT::rewrote it');
  const fine = await resume(ws);
  assert.equal(fine.status, 'COMPLETED', JSON.stringify(fine.error));
  assert.equal(await readFile(fine.steps['1.1'].files.report.path, 'utf8'), 'leftover from yesterday');
  assert.equal(await readFile(path.join(ws.dir, 'out/report.pdf'), 'utf8'), 'leftover from yesterday', 'the workspace file was left alone');
});

test('a declared path that resolves outside the workflow is refused', { skip: process.platform === 'win32' && 'symlinks need privileges' }, async t => {
  const outside = path.join(os.tmpdir(), `awe-outside-${process.pid}.txt`);
  await writeFile(outside, 'secret');
  t.after(() => (import('node:fs/promises')).then(fs => fs.rm(outside, { force: true })));
  const ws = await workspace(t, { '1.1-make.md': `SYMLINK::out/report.pdf::${outside}\nOUTPUT::linked` }, declare('1.1', report));
  const state = await resume(ws);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error.code, 'OUTPUT_INVALID');
});

test('parallel steps may not declare the same output location', async t => {
  const parallel = { '1.1-fan/FLOW.json': flow({ type: 'parallel' }), '1.1-fan/1.1.1-a.md': 'OUTPUT::a', '1.1-fan/1.1.2-b.md': 'OUTPUT::b' };
  const same = await workspace(t, parallel, { steps: { '1.1.1': { outputs: [{ name: 'f', path: 'out/x.pdf' }] }, '1.1.2': { outputs: [{ name: 'g', path: './out/x.pdf' }] } } });
  await assert.rejects(validate(same), { code: 'OUTPUT_CONFLICT' });
  await assert.rejects(resume(same), { code: 'OUTPUT_CONFLICT' });
  assert.equal(await countByStep(same.log).then(c => Object.keys(c).length), 0, 'nothing ran');
  const nested = await workspace(t, parallel, { steps: { '1.1.1': { outputs: [{ name: 'f', path: 'out/x' }] }, '1.1.2': { outputs: [{ name: 'g', path: 'out/x/y.pdf' }] } } });
  await assert.rejects(validate(nested), { code: 'OUTPUT_CONFLICT' });
  const distinct = await workspace(t, parallel, { steps: { '1.1.1': { outputs: [{ name: 'f', path: 'out/a.pdf' }] }, '1.1.2': { outputs: [{ name: 'g', path: 'out/b.pdf' }] } } });
  await validate(distinct);
  const sequence = await workspace(t, { '1.1-a.md': 'OUTPUT::a', '1.2-b.md': 'OUTPUT::b' }, { steps: { '1.1': { outputs: [{ name: 'f', path: 'out/x.pdf' }] }, '1.2': { outputs: [{ name: 'f', path: 'out/x.pdf' }] } } });
  await validate(sequence);
});

test('output declarations and file references are validated before anything runs', async t => {
  const steps = { '1.1-a.md': 'OUTPUT::a', '1.2-b.md': 'OUTPUT::b' };
  const bad = [
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: '/etc/passwd' }] } } }, /relative/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: '../up.txt' }] } } }, /inside the workflow root/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: '.awe/x' }] } } }, /\.awe/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'out/' }] } } }, /not a directory/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'out/*.pdf' }] } } }, /wildcard/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'a\\b.pdf' }] } } }, /forward slashes/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'a.pdf' }, { name: 'f', path: 'b.pdf' }] } } }, /twice/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'a.pdf' }, { name: 'g', path: 'A.pdf' }] } } }, /twice/],
    [{ steps: { '1.1': { outputs: [{ name: '1bad', path: 'a.pdf' }] } } }, /name must match/],
    [{ steps: { '1.1': { outputs: [{ name: 'f', path: 'a.pdf', optional: true }] } } }, /unsupported key/],
    [{ steps: { '1.1': { outputs: [] } } }, /non-empty array/],
    [{ steps: { '1.1': { output: [] } } }, /unsupported key/],
    [{ steps: { '9.9': { outputs: [{ name: 'f', path: 'a.pdf' }] } } }, /does not match a prompt step/],
    [{ steps: [] }, /must be an object/],
  ];
  for (const [config, message] of bad) {
    const ws = await workspace(t, steps, config);
    await assert.rejects(validate(ws), error => error.code === 'INVALID_CONFIG' && message.test(error.message), JSON.stringify(config));
  }
  const undeclared = await workspace(t, { ...steps, '1.2-b.md': 'File={{ steps["1.1"].files["nope"] }}' }, declare('1.1', report));
  await assert.rejects(validate(undeclared), error => error.code === 'MISSING_REFERENCE' && /does not declare an output file named "nope"/.test(error.message));
  const forward = await workspace(t, { '1.1-a.md': 'File={{ steps["1.2"].files["report"] }}', '1.2-b.md': 'OUTPUT::b' }, declare('1.2', report));
  await assert.rejects(validate(forward), { code: 'MISSING_REFERENCE' });
  const good = await workspace(t, { ...steps, '1.2-b.md': 'File={{ steps["1.1"].files["report"] }}' }, declare('1.1', report));
  assert.match((await validate(good)).output, /VALID/);
});

test('--dry shows placeholders for declared files; a real run saves them', async t => {
  const ws = await workspace(t, {
    '1.1-make.md': makePdf,
    '1.2-use.md': 'Attach {{ steps["1.1"].files["report"] }}\nOUTPUT::used',
  }, declare('1.1', report));
  const dry = JSON.parse((await cli(['run', ws.dir, '--dry', '--json'], ws.dir)).output);
  assert.equal(dry.dry, true);
  assert.match(dry.steps.find(item => item.id === '1.2').prompt, /Attach \[file report of 1\.1\]/);
  assert.deepEqual(await countByStep(ws.log), {}, 'nothing was executed');
  await assert.rejects(readdir(path.join(ws.dir, '.awe')), { code: 'ENOENT' }, 'and nothing was written');

  const prod = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
  assert.equal(prod.status, 'COMPLETED', JSON.stringify(prod.error));
  assert.equal(await readFile(prod.steps['1.1'].files.report.path, 'utf8'), '%PDF-1.4 fake');
  assert.ok((await calls(ws.log)).find(c => c.step === '1.2').prompt.includes(prod.steps['1.1'].files.report.path));
});

const gate = { '1.1-judge.md': 'OUTPUT::PASS' };
const ifGroup = { '1.2-if/FLOW.json': flow({ type: 'if', test: '{{ steps["1.1"].output }}', equals: 'PASS', then: 'yes', else: 'no' }), '1.2-if/no/1.2.2-other.md': 'OUTPUT::other' };

test('generated files never become workflow structure, on the first or the second command', async t => {
  const cases = {
    'a declared file that is named like a step': {
      files: { '1.1-make.md': 'WRITE::1.2-generated.md::# I am not a prompt\nOUTPUT::made' },
      config: declare('1.1', { name: 'doc', path: '1.2-generated.md' }),
      steps: ['1.1'],
    },
    'a generated folder directly inside an IF group': {
      files: { ...gate, ...ifGroup, '1.2-if/yes/1.2.1-make.md': 'WRITE::1.2-if/out/report.txt::r\nOUTPUT::made' },
      config: declare('1.2.1', { name: 'r', path: '1.2-if/out/report.txt' }),
      steps: ['1.1', '1.2.1'],
    },
    'a generated tree inside an IF branch': {
      files: { ...gate, ...ifGroup, '1.2-if/yes/1.2.1-make.md': 'WRITE::1.2-if/yes/out/generated/report.txt::r\nOUTPUT::made' },
      config: declare('1.2.1', { name: 'r', path: '1.2-if/yes/out/generated/report.txt' }),
      steps: ['1.1', '1.2.1'],
    },
  };
  for (const [name, { files, config, steps }] of Object.entries(cases)) {
    const ws = await workspace(t, files, config);
    const first = await resume(ws);
    assert.equal(first.status, 'COMPLETED', `${name}: ${JSON.stringify(first.error)}`);
    const second = await resume(ws);
    assert.equal(second.status, 'COMPLETED', `${name}: ${JSON.stringify(second.error)}`);
    assert.deepEqual([second.executed, second.reused], [0, steps.length], name);
    assert.deepEqual(Object.keys(second.steps), steps, `${name}: only real steps exist`);
    assert.match((await validate(ws)).output, /VALID/);
  }
});

const aliasable = process.platform === 'win32' ? { skip: 'symlinks need privileges' } : {};
const fan = { '1.1-fan/FLOW.json': flow({ type: 'parallel' }), '1.1-fan/1.1.1-a.md': 'SLEEP::300\nWRITE::out/report.txt::A\nOUTPUT::a', '1.1-fan/1.1.2-b.md': 'WRITE::alias/report.txt::B\nOUTPUT::b' };
const aliasConfig = { steps: { '1.1.1': { outputs: [{ name: 'f', path: 'out/report.txt' }] }, '1.1.2': { outputs: [{ name: 'g', path: 'alias/report.txt' }] } } };

test('parallel outputs that are the same file through a symlink are a conflict before anything runs', aliasable, async t => {
  const ws = await workspace(t, fan, aliasConfig);
  await mkdir(path.join(ws.dir, 'out'));
  await symlink('out', path.join(ws.dir, 'alias'), 'dir');
  await assert.rejects(validate(ws), error => error.code === 'OUTPUT_CONFLICT' && /same location on disk/.test(error.message));
  await assert.rejects(resume(ws), { code: 'OUTPUT_CONFLICT' });
  await assert.rejects(cli(['run', ws.dir], ws.dir), { code: 'OUTPUT_CONFLICT' });
  assert.deepEqual(await countByStep(ws.log), {}, 'neither executor started');
});

test('an output location that goes through a symlink is refused at capture, including aliases made while running', aliasable, async t => {
  const ws = await workspace(t, {
    '1.1-make.md': 'SYMLINK::alias::.real\nWRITE::.real/report.txt::A\nOUTPUT::made',
  }, declare('1.1', { name: 'f', path: 'alias/report.txt' }));
  await mkdir(path.join(ws.dir, '.real'));
  const state = await resume(ws);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.error.code, 'OUTPUT_INVALID');
  assert.match(state.error.message, /goes through a symlink/);
});
