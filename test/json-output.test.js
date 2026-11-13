import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, put, calls, countByStep, flow, agentCommand } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';
import { renderTemplate, templateReferences } from '../src/template.js';
import { parseJsonOutput, jsonProblems, normalizeJsonDeclaration, readJsonOutput } from '../src/json-output.js';

const THREE = '[{"role":"PM","perspective":"scope"},{"role":"Dev","perspective":"cost"},{"role":"QA","perspective":"risk"}]';
const roles = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', required: ['role', 'perspective'], properties: { role: { type: 'string' } } } };

// 1.1 answers with JSON; the three parallel branches read one role each.
const scenario = (answer = THREE, json = roles) => ({
  files: {
    '1.1-roles.md': `OUTPUT::${answer}`,
    '1.2-fan/FLOW.json': flow({ type: 'parallel' }),
    '1.2-fan/1.2.1-a.md': 'Role: {{ steps["1.1"].json[0].role }} / {{ steps["1.1"].json[0].perspective }}\nOUTPUT::a',
    '1.2-fan/1.2.2-b.md': 'Role: {{ steps["1.1"].json[1].role }} / {{ steps["1.1"].json[1].perspective }}\nOUTPUT::b',
    '1.2-fan/1.2.3-c.md': 'Role: {{ steps["1.1"].json[2].role }} / {{ steps["1.1"].json[2].perspective }}\nOUTPUT::c',
  },
  config: { steps: { '1.1': { json } } },
});
const run = (ws, args = []) => cli(['run', ws.dir, ...args, '--json'], ws.dir).then(result => ({ ...JSON.parse(result.output), exitCode: result.code }));

// ── parsing ─────────────────────────────────────────────────────────────────
test('the whole output must be JSON: fences, surrounding text and empty output are rejected with the reason', () => {
  assert.deepEqual(parseJsonOutput('  [1, 2]\n', '1.1'), [1, 2]);
  assert.deepEqual(parseJsonOutput('﻿{"a": {"b": [true, null]}}', '1.1'), { a: { b: [true, null] } });
  assert.equal(parseJsonOutput('"text"', '1.1'), 'text');
  assert.equal(parseJsonOutput('0', '1.1'), 0);
  const fails = (text, pattern) => assert.throws(() => parseJsonOutput(text, '1.1'), error => error.code === 'OUTPUT_NOT_JSON' && pattern.test(error.message), text);
  fails('```json\n[1]\n```', /wrapped in a Markdown code fence[\s\S]*no Markdown code fence, no text before or after it/);
  fails('Here you go: [1]', /starts with text before the JSON/);
  fails('[1] and that is all', /not valid JSON/);
  fails('[1, 2', /not valid JSON[\s\S]*Output starts with: "\[1, 2"/);
  fails("{'a': 1}", /not valid JSON/);
  fails('   ', /output is empty/);
  fails('', /output is empty/);
  fails('x'.repeat(300), /Output starts with: "x{160}\.\.\./);
});

// ── declarations ────────────────────────────────────────────────────────────
test('declarations: true means any JSON; anything unknown is rejected when awe.json is read', () => {
  assert.deepEqual(normalizeJsonDeclaration(true, 'steps["1.1"]'), {});
  assert.deepEqual(normalizeJsonDeclaration(roles, 'steps["1.1"]'), roles);
  const rejects = (value, pattern) => assert.throws(() => normalizeJsonDeclaration(value, 'steps["1.1"]'), error => error.code === 'INVALID_CONFIG' && pattern.test(error.message), JSON.stringify(value));
  rejects('array', /must be true \(any JSON\) or an object/);
  rejects([], /must be true/);
  rejects({ type: 'array', length: 3 }, /"json" has unsupported key "length"\. Supported: type, items, minItems, maxItems, required, properties, enum/);
  rejects({ type: 'list' }, /\.type must be one of object, array, string/);
  rejects({ minItems: -1 }, /minItems must be a non-negative integer/);
  rejects({ minItems: 4, maxItems: 3 }, /minItems is larger than maxItems/);
  rejects({ required: 'role' }, /required must be a list of field names/);
  rejects({ enum: [] }, /enum must be a non-empty list/);
  rejects({ items: { pattern: 'x' } }, /"json"\.items has unsupported key "pattern"/);
  rejects({ properties: { role: { type: 5 } } }, /"json"\.properties\.role\.type must be one of/);
});

test('jsonProblems: every violation is named with its path', () => {
  const problems = value => jsonProblems(value, roles);
  assert.deepEqual(problems(JSON.parse(THREE)), []);
  assert.deepEqual(problems(JSON.parse(THREE).slice(0, 2)), ['$ must have exactly 3 items, got 2']);
  assert.deepEqual(problems([...JSON.parse(THREE), {}]), ['$ must have exactly 3 items, got 4', '$[3].role is required', '$[3].perspective is required']);
  assert.deepEqual(problems([{ role: 'a', perspective: 'b' }, { role: 'c' }, { role: 5, perspective: 'x' }]), ['$[1].perspective is required', '$[2].role must be string, got integer']);
  assert.deepEqual(problems({ role: 'x' }), ['$ must be array, got object']);
  assert.deepEqual(problems('text'), ['$ must be array, got string']);
  assert.deepEqual(jsonProblems([1, 2], { type: 'array', minItems: 1, items: { type: 'integer' } }), []);
  assert.deepEqual(jsonProblems(1.5, { type: 'integer' }), ['$ must be integer, got number']);
  assert.deepEqual(jsonProblems(2, { type: 'number' }), [], 'an integer is a number');
  assert.deepEqual(jsonProblems(null, { type: ['string', 'null'] }), []);
  assert.deepEqual(jsonProblems('maybe', { enum: ['PASS', 'FAIL'] }), ['$ must be one of "PASS", "FAIL", got "maybe"']);
  assert.deepEqual(jsonProblems({ a: { b: 1 } }, { properties: { a: { properties: { b: { type: 'string' } } } } }), ['$.a.b must be string, got integer']);
  assert.deepEqual(jsonProblems([], { minItems: 2 }), ['$ must have at least 2 items, got 0']);
  assert.throws(() => readJsonOutput('[1]', { type: 'object' }, '2.2'), error => error.code === 'OUTPUT_JSON_INVALID' && /^The JSON output of step 2\.2 does not match its declaration in awe\.json:\n {2}\$ must be object, got array$/.test(error.message));
  const many = Array.from({ length: 9 }, () => ({}));
  assert.throws(() => readJsonOutput(JSON.stringify(many), { type: 'array', items: { required: ['x'] } }, '1.1'), /\(4 more\)/);
});

// ── template ────────────────────────────────────────────────────────────────
test('templates read JSON by key and index, and nothing else', () => {
  const data = [{ role: 'PM', n: 3, ok: false, none: null, nest: { x: 1 }, 'odd key': 'v' }, 'second'];
  const context = { input: {}, steps: { '1.1': { output: 'raw text', artifact: '/a/1-1.md', json: data } } };
  const out = source => renderTemplate(source, context);
  assert.equal(out('{{ steps["1.1"].json[0].role }}'), 'PM');
  assert.equal(out("{{ steps['1.1'].json[0].role }}"), 'PM');
  assert.equal(out('{{steps["1.1"].json[0]["role"]}}'), 'PM');
  assert.equal(out('{{ steps["1.1"].json[0]["odd key"] }}'), 'v');
  assert.equal(out('{{ steps["1.1"].json[1] }}'), 'second');
  assert.equal(out('{{ steps["1.1"].json[0].n }}-{{ steps["1.1"].json[0].ok }}'), '3-false');
  assert.equal(out('{{ steps["1.1"].json[0].nest }}'), '{"x":1}', 'objects are inserted as compact JSON');
  assert.equal(out('{{ steps["1.1"].json }}'), JSON.stringify(data), 'the whole value too');
  assert.equal(out('{{ steps["1.1"].output }}|{{ steps["1.1"].artifact }}'), 'raw text|/a/1-1.md', '.output and .artifact keep their meaning');
  const fails = (source, pattern) => assert.throws(() => out(source), error => error.code === 'MISSING_REFERENCE' && pattern.test(error.message), source);
  fails('{{ steps["1.1"].json[0].none }}', /Missing template value: steps\["1\.1"\]\.json\[0\]\.none$/);
  fails('{{ steps["1.1"].json[0].perspective }}', /There is no "perspective" at json\[0\] \(it has: role, n, ok, none, nest, odd key\)/);
  fails('{{ steps["1.1"].json[2] }}', /Index 2 is out of range at json: the array has 2 items/);
  fails('{{ steps["1.1"].json.role }}', /is not an object at json; it is an array/);
  fails('{{ steps["1.1"].json[0].role[0] }}', /is not an array at json\[0\]\.role; it is a string/);
  fails('{{ steps["1.1"].json[0].role.length }}', /is not an object at json\[0\]\.role; it is a string/);
  fails('{{ steps["1.1"].json[0].__proto__ }}', /There is no "__proto__"/);
  fails('{{ steps["1.1"].json[0].constructor }}', /There is no "constructor"/);
  fails('{{ steps["9.9"].json[0] }}', /Missing template value/);
  assert.throws(() => renderTemplate('{{ steps["1.1"].json[0] }}', { input: {}, steps: { '1.1': { output: 'x' } } }), error => /Step 1\.1 has no JSON output; declare it in awe\.json: "steps": \{ "1\.1": \{ "json": true \} \}/.test(error.message));
  // The grammar has no room for code.
  for (const bad of ['{{ steps["1.1"].json[-1] }}', '{{ steps["1.1"].json[0]( ) }}', '{{ steps["1.1"].json.a b }}', '{{ steps["1.1"].json[x] }}', '{{ steps["1.1"].json[0].a + 1 }}', '{{ steps["1.1"].jsonx }}', '{{ steps["1.1"].json["a"b"] }}', '{{ steps["1.1"].json..a }}']) {
    assert.throws(() => renderTemplate(bad, context), { code: 'INVALID_TEMPLATE' }, bad);
  }
  assert.deepEqual(templateReferences('{{ steps["1.1"].json[0].role }}')[0].jsonPath, [{ index: 0 }, { key: 'role' }]);
});

test('--dry shows where a JSON value would come from', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  const dry = JSON.parse((await cli(['run', ws.dir, '1.2.2', '--dry', '--json'], ws.dir)).output).steps[0].prompt;
  assert.equal(dry, 'Role: [json of 1.1[1].role] / [json of 1.1[1].perspective]\nOUTPUT::b');
  assert.deepEqual(await calls(ws.log), [], 'nothing ran');
});

// ── a run ───────────────────────────────────────────────────────────────────
test('three roles, three parallel branches: each branch reads its own item', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const prompts = Object.fromEntries((await calls(ws.log)).map(call => [call.step, call.prompt]));
  assert.equal(prompts['1.2.1'], 'Role: PM / scope\nOUTPUT::a');
  assert.equal(prompts['1.2.2'], 'Role: Dev / cost\nOUTPUT::b');
  assert.equal(prompts['1.2.3'], 'Role: QA / risk\nOUTPUT::c');
  assert.equal(await readFile(state.steps['1.1'].artifact, 'utf8'), THREE, '.artifact is still the raw output file');
  assert.equal((await cli(['show', ws.dir, '1.1'], ws.dir)).output, THREE, 'and awe show prints the raw text');
});

for (const [name, answer, code, pattern] of [
  ['a Markdown code fence', '```json [{"role":"PM","perspective":"x"}] ```', 'OUTPUT_NOT_JSON', /wrapped in a Markdown code fence/],
  ['text around the JSON', `Here are the roles: ${THREE}`, 'OUTPUT_NOT_JSON', /starts with text before the JSON/],
  ['a trailing remark', `${THREE} Hope that helps`, 'OUTPUT_NOT_JSON', /not valid JSON/],
  ['fewer than three items', '[{"role":"PM","perspective":"a"},{"role":"Dev","perspective":"b"}]', 'OUTPUT_JSON_INVALID', /\$ must have exactly 3 items, got 2/],
  ['more than three items', JSON.stringify([...JSON.parse(THREE), { role: 'Ops', perspective: 'run' }]), 'OUTPUT_JSON_INVALID', /\$ must have exactly 3 items, got 4/],
  ['a missing field', '[{"role":"PM","perspective":"a"},{"role":"Dev"},{"role":"QA","perspective":"c"}]', 'OUTPUT_JSON_INVALID', /\$\[1\]\.perspective is required/],
  ['a field of the wrong type', '[{"role":1,"perspective":"a"},{"role":"Dev","perspective":"b"},{"role":"QA","perspective":"c"}]', 'OUTPUT_JSON_INVALID', /\$\[0\]\.role must be string, got integer/],
  ['an object instead of an array', '{"role":"PM","perspective":"a"}', 'OUTPUT_JSON_INVALID', /\$ must be array, got object/],
]) {
  test(`1.1 fails on ${name}, and no parallel branch starts`, async t => {
    const { files, config } = scenario(answer);
    const ws = await workspace(t, files, config);
    const result = await cli(['run', ws.dir], ws.dir);
    assert.equal(result.code, 1);
    assert.match(result.output, new RegExp(`1\\.1 +FAILED +`));
    assert.match(result.output, pattern);
    assert.match(result.output, /The model's raw output is saved in \.awe[\\/]runs[\\/]/);
    assert.match(result.output, /^Next {2}awe run 1\.1 {3}\(after fixing the prompt, or the "json" declaration in awe\.json\)$/m);
    assert.deepEqual(await countByStep(ws.log), { '1.1': 1 }, 'only 1.1 ran');
    const state = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
    assert.equal(state.error.code, code);
    assert.equal(state.steps['1.1'].status, 'FAILED');
    assert.equal(await readFile(state.steps['1.1'].rejectedArtifact, 'utf8'), answer, 'the raw output is kept for debugging');
    assert.equal(state.steps['1.2.1'], undefined);
  });
}

test('a rejected output is a known failure: it never needs --retry, and the next run can fix it', async t => {
  const { files, config } = scenario('not json');
  const ws = await workspace(t, files, config);
  assert.equal((await run(ws)).error.code, 'OUTPUT_NOT_JSON');
  await put(ws.dir, '1.1-roles.md', `OUTPUT::${THREE}`);
  const fixed = await run(ws);
  assert.equal(fixed.status, 'COMPLETED', JSON.stringify(fixed.error));
});

// ── check ───────────────────────────────────────────────────────────────────
test('awe check verifies the syntax and the declaration, not the data', async t => {
  const { files } = scenario();
  const undeclared = await workspace(t, files, {});
  await assert.rejects(cli(['check', undeclared.dir], undeclared.dir), { code: 'MISSING_REFERENCE', message: /1\.2\.1-a\.md: \{\{ steps\["1\.1"\]\.json\[0\]\.role \}\} reads the JSON output of step 1\.1, but awe\.json does not declare it\. Add: "steps": \{ "1\.1": \{ "json": true \} \}/ });
  const declared = await workspace(t, files, { steps: { '1.1': { json: true } } });
  assert.match((await cli(['check', declared.dir], declared.dir)).output, /VALID .*\(4 prompt steps\)/, 'any index is accepted: the data is checked when it exists');
  await assert.rejects(cli(['check', (await workspace(t, files, { steps: { '1.1': { json: { type: 'array', size: 3 } } } })).dir]), { code: 'INVALID_CONFIG', message: /steps\["1\.1"\]: "json" has unsupported key "size"/ });
  await assert.rejects(cli(['check', (await workspace(t, files, { steps: { '1.1': { json: true }, '9.9': { json: true } } })).dir]), { code: 'INVALID_CONFIG', message: /does not match a prompt step/ });
  const syntax = await workspace(t, { ...files, '1.2-fan/1.2.1-a.md': '{{ steps["1.1"].json[0]. }}' }, { steps: { '1.1': { json: true } } });
  await assert.rejects(cli(['check', syntax.dir]), { code: 'INVALID_TEMPLATE' });
  // not before the step has run
  const early = await workspace(t, { '1.1-a.md': '{{ steps["1.2"].json[0] }}', '1.2-b.md': 'OUTPUT::[]' }, { steps: { '1.2': { json: true } } });
  await assert.rejects(cli(['check', early.dir]), { code: 'MISSING_REFERENCE', message: /not guaranteed to be available/ });
  assert.equal((await cli(['check', declared.dir, '--json'], declared.dir)).code, 0);
});

// ── cache ───────────────────────────────────────────────────────────────────
test('cached JSON steps hand their parsed value to later steps', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  assert.equal((await run(ws)).status, 'COMPLETED');
  // 1.1 comes from the cache; the branch that is run reads it from the stored output.
  const again = await run(ws, ['1.2.2']);
  assert.equal(again.status, 'COMPLETED', JSON.stringify(again.error));
  assert.equal(again.steps['1.1'].reused.attempt, 1);
  assert.equal((await calls(ws.log)).filter(call => call.step === '1.2.2').at(-1).prompt, 'Role: Dev / cost\nOUTPUT::b');
  assert.equal((await countByStep(ws.log))['1.1'], 1, '1.1 was not run again');
});

test('changing the JSON declaration invalidates the step and what follows it, and says why', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  await run(ws);
  const next = { ...config, steps: { '1.1': { json: { ...roles, items: { type: 'object', required: ['role'] } } } } };
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: agentCommand(ws.log), ...next }));
  const out = (await cli(['run', ws.dir, '1.2.1', '--cache'], ws.dir)).output;
  assert.match(out, /^ {2}1\.1 +ran +\S+ +\(its JSON declaration changed\)/m);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 2, '1.2.1': 2, '1.2.2': 1, '1.2.3': 1 });
  // A declaration the stored output no longer satisfies fails the rerun instead of being reused.
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: agentCommand(ws.log), steps: { '1.1': { json: { type: 'array', minItems: 4 } } } }));
  const strict = await run(ws, ['1.1']);
  assert.equal(strict.error.code, 'OUTPUT_JSON_INVALID');
});

test('removing a JSON declaration is also a change', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::[1,2]', '1.2-b.md': 'OUTPUT::done' }, { steps: { '1.1': { json: true } } });
  await run(ws);
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: agentCommand(ws.log) }));
  assert.match((await cli(['run', ws.dir, '1.2'], ws.dir)).output, /^ {2}1\.1 +ran +\S+ +\(its JSON declaration changed\)/m);
});

test('a stored output that is tampered with is not reused, and JSON that no longer parses is rerun', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  const first = await run(ws);
  await writeFile(first.steps['1.1'].artifact, 'tampered');
  const second = await run(ws, ['--cache']);
  assert.ok(second.events.some(event => event.type === 'CACHE_INVALID' && event.node === '1.1'));
  assert.equal(second.status, 'COMPLETED');
  assert.equal((await countByStep(ws.log))['1.1'], 2);
});

// ── in flows ────────────────────────────────────────────────────────────────
test('an IF gate can read a field of a JSON step', async t => {
  const ws = await workspace(t, {
    '1.1-judge.md': 'OUTPUT::{"verdict":"PASS","score":9}',
    '1.2-route/FLOW.json': flow({ type: 'if', test: '{{ steps["1.1"].json.verdict }}', equals: 'PASS', then: 'yes', else: 'no' }),
    '1.2-route/yes/1.2.1-ship.md': 'Score {{ steps["1.1"].json.score }}\nOUTPUT::ship',
    '1.2-route/no/1.2.2-fix.md': 'OUTPUT::fix',
  }, { steps: { '1.1': { json: { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['PASS', 'FAIL'] } } } } } });
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.equal(state.events.find(event => event.type === 'IF_BRANCH').branch, 'yes');
  assert.equal((await calls(ws.log)).find(call => call.step === '1.2.1').prompt, 'Score 9\nOUTPUT::ship');
});

test('inside a LOOP every iteration is parsed on its own', async t => {
  const ws = await workspace(t, {
    '1.1-loop/FLOW.json': flow({ type: 'loop', until: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-work.md': 'OUTPUT::{"n":{n}}',
    '1.1-loop/1.1.2-check.md': 'PASS_IF_NUM_GTE::2::{{ steps["1.1.1"].json.n }}',
  }, { steps: { '1.1.1': { json: { type: 'object', required: ['n'] } } } });
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const gates = (await calls(ws.log)).filter(call => call.step === '1.1.2').map(call => call.prompt);
  assert.deepEqual(gates, ['PASS_IF_NUM_GTE::2::1', 'PASS_IF_NUM_GTE::2::2'], 'each iteration reads its own parsed value');
  // `awe show 1.1.1@2` still prints the raw text of that iteration.
  assert.equal((await cli(['show', ws.dir, '1.1.1@2'], ws.dir)).output, '{"n":2}');
});
