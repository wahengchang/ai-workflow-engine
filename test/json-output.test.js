import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspace, put, calls, countByStep, flow, agentCommand, formatterCommand, schemaEcho } from '../fixtures/helpers.mjs';
import { cli } from '../src/cli.js';
import { renderTemplate, templateReferences } from '../src/template.js';
import { parseJsonOutput, jsonProblems, normalizeJsonDeclaration, readJsonOutput, buildFormatPrompt, FORMAT_PROMPT_VERSION } from '../src/json-output.js';
import { normalizeConfig, resolveFormatter } from '../src/config.js';

const THREE = '[{"role":"PM","perspective":"scope"},{"role":"Dev","perspective":"cost"},{"role":"QA","perspective":"risk"}]';
const roles = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', required: ['role', 'perspective'], properties: { role: { type: 'string' } } } };

// A workflow whose "formatter" is the test double in fixtures/formatter.cjs. ws.flog logs its calls; ws.log is
// the agent that runs the steps themselves.
async function jsonWorkspace(t, files, config = {}) {
  const flog = path.join(os.tmpdir(), `awe-formatter-${randomUUID()}.jsonl`);
  t.after(() => rm(flog, { force: true }));
  const ws = await workspace(t, files, { formatter: formatterCommand(flog), ...config });
  return { ...ws, flog };
}
const writeConfig = (ws, config) => put(ws.dir, 'awe.json', JSON.stringify({ version: 2, run: agentCommand(ws.log), formatter: formatterCommand(ws.flog), ...config }));

// 1.1 answers (here already as JSON text); the three parallel branches read one role each.
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
  rejects({ type: 'array', length: 3 }, /"json" has unsupported key "length"\. Supported: type, items, minItems, maxItems, required, properties, enum, additionalProperties, description/);
  rejects({ additionalProperties: 'no' }, /additionalProperties must be true or false/);
  rejects({ description: 5 }, /description must be a string/);
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

test('enum compares JSON values structurally, regardless of object key order', () => {
  const schema = { enum: [{ role: 'QA', details: { active: true, ranks: [1, null] } }] };
  assert.deepEqual(jsonProblems({ details: { ranks: [1, null], active: true }, role: 'QA' }, schema), []);
  for (const value of [
    { role: 'QA', details: { active: true, ranks: [null, 1] } },
    { role: 'QA', details: { active: true, ranks: [1, null] }, extra: true },
    { role: 'QA' },
    null,
    [],
  ]) assert.equal(jsonProblems(value, schema).length, 1, JSON.stringify(value));
  assert.deepEqual(jsonProblems(-0, { enum: [0] }), []);
  assert.deepEqual(jsonProblems([1, { b: 2, a: 3 }], { enum: [[1, { a: 3, b: 2 }]] }), []);
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
  assert.equal(out('{{ steps["1.1"].json[0].none }}'), 'null');
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

test('own JSON keys named __proto__ and constructor are plain data; inherited keys stay inaccessible', () => {
  const context = { steps: { '1.1': { json: JSON.parse('{"__proto__":{"role":"QA"},"constructor":"label"}') } } };
  assert.equal(renderTemplate('{{ steps["1.1"].json.__proto__.role }}', context), 'QA');
  assert.equal(renderTemplate('{{ steps["1.1"].json.constructor }}', context), 'label');
  assert.throws(() => renderTemplate('{{ steps["1.1"].json.toString }}', context), { code: 'MISSING_REFERENCE' });
  assert.equal(Object.hasOwn(Object.prototype, 'role'), false);
});

test('--dry shows where a JSON value would come from', async t => {
  const { files, config } = scenario();
  const ws = await workspace(t, files, config);
  const dry = JSON.parse((await cli(['run', ws.dir, '1.2.2', '--dry', '--json'], ws.dir)).output).steps[0].prompt;
  assert.equal(dry, 'Role: [json of 1.1[1].role] / [json of 1.1[1].perspective]\nOUTPUT::b');
  assert.deepEqual(await calls(ws.log), [], 'nothing ran');
});

// ── the formatter's prompt and the schema keywords ──────────────────────────
test('the formatter prompt is fixed: the rules, the schema, the text between markers', () => {
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string', description: 'a short title' } }, additionalProperties: false };
  const prompt = buildFormatPrompt('Title: The Fox', schema);
  assert.match(prompt, /^Convert the text between the TEXT markers into JSON that matches the schema\./);
  assert.match(prompt, /Reply with the JSON only: no Markdown code fence, no explanation, no text before or after it\./);
  assert.match(prompt, /Do not invent values\. Keep the language of the text/);
  assert.ok(prompt.includes(JSON.stringify(schema, null, 2)));
  assert.ok(prompt.endsWith('--- TEXT START ---\nTitle: The Fox\n--- TEXT END ---\n'));
  assert.equal(FORMAT_PROMPT_VERSION, 1);
});

test('additionalProperties:false rejects fields the declaration does not list; description is only a hint', () => {
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string', description: 'short' } }, additionalProperties: false };
  assert.deepEqual(jsonProblems({ title: 'x' }, schema), []);
  assert.deepEqual(jsonProblems({ title: 'x', extra: 1, more: 2 }, schema), ['$.extra is not allowed', '$.more is not allowed']);
  assert.deepEqual(jsonProblems({ title: 'x', extra: 1 }, { ...schema, additionalProperties: true }), []);
  assert.deepEqual(jsonProblems({ any: 1 }, { type: 'object' }), [], 'unlisted fields are fine unless forbidden');
});

test('formatter settings: a command string, per-step override, falls back to run, no schema placeholders elsewhere', () => {
  const settings = config => normalizeConfig({ version: 2, ...config });
  const withJson = { steps: { '1.1': { json: true } } };
  assert.equal(resolveFormatter(settings({ run: 'a {prompt}', ...withJson }), '1.1').display, 'a {prompt}', 'no formatter: the run command');
  const set = settings({ run: 'a {prompt}', formatter: 'b --json {prompt}', steps: { '1.1': { json: true }, '1.2': { json: true, formatter: 'c {schema_file} {prompt}' } } });
  assert.equal(resolveFormatter(set, '1.1').display, 'b --json {prompt}');
  assert.equal(resolveFormatter(set, '1.2').display, 'c {schema_file} {prompt}', 'the step wins over the top level');
  assert.equal(resolveFormatter(set, '1.1', { timeoutSeconds: 7 }).timeoutMs, 7000);
  assert.equal(resolveFormatter(settings({ run: 'a', timeout: 9, ...withJson }), '1.1').timeoutMs, 9000);
  // No formatter and no "run": the step's own command answers in prose and makes the JSON.
  const perStep = settings({ executors: { codex: 'codex exec {prompt}' }, steps: { '1.1': { json: true, executor: 'codex' } } });
  assert.equal(resolveFormatter(perStep, '1.1').display, 'codex exec {prompt}');
  assert.equal(resolveFormatter(settings({ executors: { codex: 'x' }, steps: { '1.1': { json: true } } }), '1.1', { executor: 'codex' }).display, 'x', 'a --executor override reaches it too');
  assert.throws(() => resolveFormatter(settings({}), '1.1'), { code: 'NO_EXECUTOR' });
  const rejects = (config, pattern) => assert.throws(() => settings(config), error => error.code === 'INVALID_CONFIG' && pattern.test(error.message), JSON.stringify(config));
  rejects({ formatter: 5 }, /"formatter" must be a command string/);
  rejects({ formatter: '' }, /empty/);
  rejects({ steps: { '1.1': { formatter: 'x' } } }, /steps\["1\.1"\]\.formatter needs "json" in the same step/);
  rejects({ steps: { '1.1': { json: true, formatter: 5 } } }, /\.formatter must be a command string/);
  rejects({ run: 'a {schema}' }, /\{schema\} and \{schema_file\} are only for "formatter" commands/);
  rejects({ executors: { x: 'a {schema_file}' } }, /only for "formatter" commands/);
});

test('without "formatter" or "run", a step\'s own executor makes its JSON', async t => {
  // One command for both jobs: prose when it is asked for the step, JSON when the formatter's built-in prompt
  // (which carries the TEXT markers) is what it receives.
  const script = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(s.includes('TEXT START')?'{\"a\":1}':'prose answer'))";
  const mock = [process.execPath, '-e', script].map(token => JSON.stringify(token)).join(' ');
  const ws = await workspace(t, { '1.1-a.md': 'Tell me about a', '1.2-b.md': 'Got {{ steps["1.1"].json.a }}\nOUTPUT::done' });
  // Executors only: each step names its command, and there is no top-level "run" to fall back to.
  await put(ws.dir, 'awe.json', JSON.stringify({ version: 2, executors: { mock }, steps: { '1.1': { json: true, executor: 'mock' }, '1.2': { executor: 'mock' } } }));
  assert.match((await cli(['check', ws.dir], ws.dir)).output, /^Executor {2}formatter \(JSON of 1\.1\): /m);
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  assert.equal(state.steps['1.1'].outputPreview, 'prose answer', '.output stays the prose');
  assert.equal(await readFile(state.steps['1.1'].format.artifact, 'utf8'), '{"a":1}');
});

// ── a step and its formatter ────────────────────────────────────────────────
test('the step answers in prose, the formatter makes the JSON: .output stays the prose, .json is the result', async t => {
  const ws = await jsonWorkspace(t, {
    '1.1-story.md': 'OUTPUT::Title: The Fox. About a fox who learns to share. FORMAT_TO::{"title":"The Fox","description":"About a fox who learns to share"}',
    '1.2-use.md': 'Raw: {{ steps["1.1"].output }}\nTitle: {{ steps["1.1"].json.title }}\nOUTPUT::used',
  }, { steps: { '1.1': { json: { type: 'object', required: ['title', 'description'], properties: { title: { type: 'string' } } } } } });
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const prompt = (await calls(ws.log)).find(call => call.step === '1.2').prompt;
  assert.match(prompt, /^Raw: Title: The Fox\. About a fox who learns to share\. FORMAT_TO::\{.*\}\nTitle: The Fox\nOUTPUT::used$/s);
  // The first step's own prompt says nothing about JSON; the formatter got the fixed prompt, the schema and the text.
  assert.equal((await calls(ws.log)).find(call => call.step === '1.1').prompt, 'OUTPUT::Title: The Fox. About a fox who learns to share. FORMAT_TO::{"title":"The Fox","description":"About a fox who learns to share"}');
  const formatterCalls = await calls(ws.flog);
  assert.equal(formatterCalls.length, 1);
  assert.deepEqual([formatterCalls[0].step, formatterCalls[0].address], ['1.1', '1.1 json']);
  assert.match(formatterCalls[0].prompt, /Reply with the JSON only[\s\S]*"required": \[\s*"title",\s*"description"\s*\][\s\S]*--- TEXT START ---\nTitle: The Fox\./);
  assert.equal(await readFile(state.steps['1.1'].artifact, 'utf8').then(text => text.startsWith('Title: The Fox')), true, '.artifact is the prose');
  assert.equal(state.steps['1.1'].format.status, 'COMPLETED');
  assert.equal(await readFile(state.steps['1.1'].format.artifact, 'utf8'), '{"title":"The Fox","description":"About a fox who learns to share"}');
  assert.equal(state.steps['1.1'].format.executor, 'formatter');
  // awe show prints both
  const shown = (await cli(['show', ws.dir, '1.1'], ws.dir)).output;
  assert.match(shown, /^── output ──\nTitle: The Fox\..*\n\n── json ──\n\{"title":"The Fox","description":"About a fox who learns to share"\}$/s);
  assert.match((await cli(['show', ws.dir, '1.1', '--prompt'], ws.dir)).output, /^── prompt ──\nOUTPUT::Title.*\n\n── json prompt ──\nConvert the text between the TEXT markers/s);
  assert.equal((await cli(['show', ws.dir, '1.2'], ws.dir)).output, 'used', 'a step without a declaration prints as before');
});

test('the run lists the formatter under its step; the header and the counts name it', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  const out = (await cli(['run', ws.dir], ws.dir)).output;
  assert.match(out, /^Workflow {2}\S+ \(4 steps in plan\) {4}Executor {2}\S+ … … · formatter=\S+ … …$/m);
  assert.match(out, /^ {2}1\.1 +ran +\S+ +-> /m);
  assert.match(out, /^ {2}1\.1 json +ran +\S+ +-> \.awe[\\/]runs[\\/].*1-1-json-attempt-1\.md$/m);
  assert.match(out, /^Reused 0 steps · Ran 5 steps {3}\(1 JSON formatter run included\)$/m);
  const cached = (await cli(['run', ws.dir, '--cache'], ws.dir)).output;
  assert.match(cached, /^ {2}1\.1 json +cached +\d\d:\d\d$/m);
});

test('--dry also shows the formatter prompt, with the step text as a placeholder', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  const dry = (await cli(['run', ws.dir, '1.1', '--dry'], ws.dir)).output;
  assert.match(dry, /──── 1\.1 json {2}built-in formatter prompt ────\nConvert the text between the TEXT markers[\s\S]*--- TEXT START ---\n\[output of 1\.1\]\n--- TEXT END ---/);
  const json = JSON.parse((await cli(['run', ws.dir, '--dry', '--json'], ws.dir)).output).steps.map(step => step.id);
  assert.deepEqual(json, ['1.1', '1.1 json', '1.2.1', '1.2.2', '1.2.3']);
  assert.deepEqual(await calls(ws.flog), [], 'nothing ran');
  assert.deepEqual(await calls(ws.log), []);
});

test('{schema} and {schema_file}: the formatter command can use a tool\'s own structured-output flags', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::prose' }, {
    formatter: [process.execPath, schemaEcho, '{schema}', '{schema_file}'].map(token => JSON.stringify(token)).join(' '),
    steps: { '1.1': { json: { type: 'object', required: ['arg', 'file'] } } },
  });
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const made = JSON.parse(await readFile(state.steps['1.1'].format.artifact, 'utf8'));
  assert.deepEqual(JSON.parse(made.arg), { type: 'object', required: ['arg', 'file'] }, '{schema} is the declaration as JSON text');
  assert.equal(made.file, made.arg, '{schema_file} is a file holding the same text');
  assert.match((await calls(ws.log)).at(-1).prompt, /prose/, 'the step itself is unaffected');
});

test('a formatter that exits non-zero fails the step\'s formatter with its stderr, and the step stays cached', async t => {
  const ws = await workspace(t, { '1.1-a.md': 'OUTPUT::prose' }, { formatter: `${JSON.stringify(process.execPath)} -e "console.error('quota exceeded'); process.exit(3)"`, steps: { '1.1': { json: true } } });
  const result = await cli(['run', ws.dir], ws.dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /^ {2}1\.1 +ran /m);
  assert.match(result.output, /^ {2}1\.1 json +FAILED +Command exited 3: quota exceeded$/m);
  assert.match(result.output, /^Next {2}awe run --cache {3}\(1\.1 comes from the cache, so only its formatter runs again; fix the "json" declaration or the formatter command first\)$/m);
  assert.equal((await countByStep(ws.log))['1.1'], 1);
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
  test(`the formatter's answer is rejected on ${name}, and no parallel branch starts`, async t => {
    const { files, config } = scenario(answer);
    const ws = await jsonWorkspace(t, files, config);
    const result = await cli(['run', ws.dir], ws.dir);
    assert.equal(result.code, 1);
    assert.match(result.output, /^ {2}1\.1 +ran /m, 'the step itself finished');
    assert.match(result.output, /^ {2}1\.1 json +FAILED +/m, 'its formatter is what failed');
    assert.match(result.output, pattern);
    assert.match(result.output, /The formatter's output is saved in \.awe[\\/]runs[\\/]/);
    assert.match(result.output, /^Next {2}awe run --cache {3}\(1\.1 comes from the cache, so only its formatter runs again/m);
    assert.deepEqual(await countByStep(ws.log), { '1.1': 1 }, 'no branch started');
    assert.equal((await calls(ws.flog)).length, 1);
    const state = JSON.parse((await cli(['run', ws.dir, '--json'], ws.dir)).output);
    assert.equal(state.error.code, code);
    assert.equal(state.error.step, '1.1 json');
    assert.equal(state.steps['1.1'].status, 'COMPLETED');
    assert.equal(state.steps['1.1'].format.status, 'FAILED');
    assert.equal(await readFile(state.steps['1.1'].format.rejectedArtifact, 'utf8'), answer, 'what the formatter returned is kept for debugging');
    assert.equal(state.steps['1.2.1'], undefined);
  });
}

test('after a failed conversion, `awe run --cache` reruns only the formatter', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  await put(ws.dir, 'formatter.fail', 'x');
  const failed = await run(ws);
  assert.equal(failed.error.code, 'OUTPUT_NOT_JSON');
  await rm(path.join(ws.dir, 'formatter.fail'));
  const fixed = await run(ws, ['--cache']);
  assert.equal(fixed.status, 'COMPLETED', JSON.stringify(fixed.error));
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 1, '1.2.2': 1, '1.2.3': 1 }, 'the step before it was not asked again');
  assert.equal((await calls(ws.flog)).length, 2, 'the formatter ran twice');
  assert.ok(fixed.steps['1.1'].reused, 'the step came from the cache');
  assert.equal(fixed.steps['1.1'].format.attempts, 1);
});

test('three roles, three parallel branches: each branch reads its own item', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const prompts = Object.fromEntries((await calls(ws.log)).map(call => [call.step, call.prompt]));
  assert.equal(prompts['1.2.1'], 'Role: PM / scope\nOUTPUT::a');
  assert.equal(prompts['1.2.2'], 'Role: Dev / cost\nOUTPUT::b');
  assert.equal(prompts['1.2.3'], 'Role: QA / risk\nOUTPUT::c');
  assert.equal(await readFile(state.steps['1.1'].artifact, 'utf8'), THREE, '.artifact is still the step\'s own output file');
});

test('JSON null can be read as a whole value, a field and an IF gate, including from cache', async t => {
  const ws = await jsonWorkspace(t, {
    '1.1-null.md': 'OUTPUT::null',
    '1.2-object.md': 'OUTPUT::{"value":null}',
    '1.3-route/FLOW.json': flow({ type: 'if', test: '{{ steps["1.1"].json }}', equals: 'null', then: 'yes', else: 'no' }),
    '1.3-route/yes/1.3.1-use.md': 'Whole {{ steps["1.1"].json }} / field {{ steps["1.2"].json.value }}\nOUTPUT::done',
    '1.3-route/no/1.3.2-other.md': 'OUTPUT::wrong branch',
  }, { steps: { '1.1': { json: { type: 'null' } }, '1.2': { json: true } } });
  assert.equal((await run(ws)).status, 'COMPLETED');
  const cached = await run(ws, ['1.3.1']);
  assert.equal(cached.status, 'COMPLETED', JSON.stringify(cached.error));
  assert.equal(cached.reused, 4, 'two steps and their two formatters');
  assert.equal((await calls(ws.log)).filter(call => call.step === '1.3.1').at(-1).prompt, 'Whole null / field null\nOUTPUT::done');
});

test('show: the step\'s text, then what its formatter made of it, or what it returned when rejected', async t => {
  const ws = await jsonWorkspace(t, { '1.1-json.md': 'OUTPUT::fine FORMAT_TO::{}' }, { steps: { '1.1': { json: { type: 'object' } } } });
  const success = await run(ws);
  await put(ws.dir, 'formatter.fail', 'x');
  await put(ws.dir, '1.1-json.md', 'OUTPUT::second try');
  const rejected = await run(ws);
  assert.equal(rejected.error.code, 'OUTPUT_NOT_JSON');
  assert.equal((await cli(['show', ws.dir, '1.1'], ws.dir)).output, '── output ──\nsecond try\n\n── json (rejected: The formatter of step 1.1 must output JSON only, but its output is not valid JSON. The output starts with text before the JSON.) ──\nSorry, I cannot do that.');
  const record = JSON.parse((await cli(['show', ws.dir, '1.1', '--json'], ws.dir)).output);
  assert.equal(record.format.status, 'FAILED');
  assert.equal(record.format.rejectedArtifact, rejected.steps['1.1'].format.rejectedArtifact);
  assert.equal((await cli(['show', ws.dir, '1.1', '--run', success.runId], ws.dir)).output, '── output ──\nfine FORMAT_TO::{}\n\n── json ──\n{}');
  assert.match((await cli(['show', ws.dir], ws.dir)).output, /^ {2}1\.1 json +FAILED +The formatter of step 1\.1 must output JSON only/m);
});

test('show reads a UNTIL occurrence together with its formatter', async t => {
  const ws = await jsonWorkspace(t, {
    '1.1-loop/FLOW.json': flow({ type: 'until', test: '{{ steps["1.1.2"].output }}', equals: 'PASS', maxIterations: 3 }),
    '1.1-loop/1.1.1-work.md': 'OUTPUT::{"n":{n}}',
    '1.1-loop/1.1.2-check.md': 'PASS_IF_NUM_GTE::2::{{ steps["1.1.1"].json.n }}',
  }, { steps: { '1.1.1': { json: { type: 'object', required: ['n'] } } } });
  const state = await run(ws);
  assert.equal(state.status, 'COMPLETED', JSON.stringify(state.error));
  const gates = (await calls(ws.log)).filter(call => call.step === '1.1.2').map(call => call.prompt);
  assert.deepEqual(gates, ['PASS_IF_NUM_GTE::2::1', 'PASS_IF_NUM_GTE::2::2'], 'each iteration reads its own parsed value');
  assert.deepEqual((await calls(ws.flog)).map(call => call.address), ['1.1.1@1 json', '1.1.1@2 json']);
  assert.equal((await cli(['show', ws.dir, '1.1.1@2'], ws.dir)).output, '── output ──\n{"n":2}\n\n── json ──\n{"n":2}');
  assert.equal((await cli(['show', ws.dir, '1.1.1@1'], ws.dir)).output, '── output ──\n{"n":1}\n\n── json ──\n{"n":1}');
});

test('a formatter failure blocks its branch and the join, while successful parallel siblings remain reusable', async t => {
  const ws = await jsonWorkspace(t, {
    '1.1-fan/FLOW.json': flow({ type: 'parallel' }),
    '1.1-fan/1.1.1-bad/1.1.1.1-json.md': 'OUTPUT::wrong',
    '1.1-fan/1.1.1-bad/1.1.1.2-after.md': 'OUTPUT::after JSON',
    '1.1-fan/1.1.2-good.md': 'OUTPUT::sibling',
    '1.2-join.md': 'OUTPUT::joined',
  }, { steps: { '1.1.1.1': { json: true } } });
  const failed = await run(ws);
  assert.equal(failed.error.code, 'OUTPUT_NOT_JSON');
  assert.deepEqual(await countByStep(ws.log), { '1.1.1.1': 1, '1.1.2': 1 });
  assert.equal(failed.steps['1.1.2'].status, 'COMPLETED');
  await put(ws.dir, '1.1-fan/1.1.1-bad/1.1.1.1-json.md', 'OUTPUT::{}');
  const fixed = await run(ws, ['--cache']);
  assert.equal(fixed.status, 'COMPLETED', JSON.stringify(fixed.error));
  assert.ok(fixed.steps['1.1.2'].reused);
  assert.deepEqual(await countByStep(ws.log), { '1.1.1.1': 2, '1.1.1.2': 1, '1.1.2': 1, '1.2': 1 });
});

// ── check ───────────────────────────────────────────────────────────────────
test('awe check verifies the syntax and the declaration, and that the formatter exists, not the data', async t => {
  const { files } = scenario();
  const undeclared = await jsonWorkspace(t, files, {});
  await assert.rejects(cli(['check', undeclared.dir], undeclared.dir), { code: 'MISSING_REFERENCE', message: /1\.2\.1-a\.md: \{\{ steps\["1\.1"\]\.json\[0\]\.role \}\} reads the JSON output of step 1\.1, but awe\.json does not declare it\. Add: "steps": \{ "1\.1": \{ "json": true \} \}/ });
  const declared = await jsonWorkspace(t, files, { steps: { '1.1': { json: true } } });
  const checked = await cli(['check', declared.dir], declared.dir);
  assert.match(checked.output, /VALID .*\(4 prompt steps\)/, 'any index is accepted: the data is checked when it exists');
  assert.match(checked.output, /^Executor {2}formatter \(JSON of 1\.1\): \S+ … …   \(found: /m);
  assert.equal(checked.warnings.length, 0);
  const missing = await workspace(t, files, { formatter: 'awe-no-such-formatter {prompt}', steps: { '1.1': { json: true } } });
  assert.match((await cli(['check', missing.dir], missing.dir)).output, /Executor {2}formatter \(JSON of 1\.1\): awe-no-such-formatter \{prompt\} {3}NOT READY — "awe-no-such-formatter" was not found on PATH/);
  const json = JSON.parse((await cli(['check', missing.dir, '--json'], missing.dir)).output);
  assert.equal(json.ready, false);
  assert.deepEqual(json.executors.filter(item => item.name === 'formatter').map(item => item.steps), [['1.1']]);
  const idle = await jsonWorkspace(t, { '1.1-a.md': 'x' }, {});
  assert.deepEqual((await cli(['check', idle.dir], idle.dir)).warnings, ['awe.json has "formatter", but no step declares "json", so it is never used.']);
  await assert.rejects(cli(['check', (await workspace(t, files, { steps: { '1.1': { json: { type: 'array', size: 3 } } } })).dir]), { code: 'INVALID_CONFIG', message: /steps\["1\.1"\]: "json" has unsupported key "size"/ });
  await assert.rejects(cli(['check', (await workspace(t, files, { steps: { '1.1': { json: true }, '9.9': { json: true } } })).dir]), { code: 'INVALID_CONFIG', message: /does not match a prompt step/ });
  const syntax = await workspace(t, { ...files, '1.2-fan/1.2.1-a.md': '{{ steps["1.1"].json[0]. }}' }, { steps: { '1.1': { json: true } } });
  await assert.rejects(cli(['check', syntax.dir]), { code: 'INVALID_TEMPLATE' });
  const early = await workspace(t, { '1.1-a.md': '{{ steps["1.2"].json[0] }}', '1.2-b.md': 'OUTPUT::[]' }, { steps: { '1.2': { json: true } } });
  await assert.rejects(cli(['check', early.dir]), { code: 'MISSING_REFERENCE', message: /not guaranteed to be available/ });
});

// ── cache ───────────────────────────────────────────────────────────────────
test('cached JSON steps hand their parsed value to later steps', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  assert.equal((await run(ws)).status, 'COMPLETED');
  const again = await run(ws, ['1.2.2']);
  assert.equal(again.status, 'COMPLETED', JSON.stringify(again.error));
  assert.equal(again.steps['1.1'].reused.attempt, 1);
  assert.equal(again.steps['1.1'].format.reused.attempt, 1, 'and so did its formatter');
  assert.equal((await calls(ws.log)).filter(call => call.step === '1.2.2').at(-1).prompt, 'Role: Dev / cost\nOUTPUT::b');
  assert.equal((await countByStep(ws.log))['1.1'], 1, '1.1 was not run again');
  assert.equal((await calls(ws.flog)).length, 1, 'neither was its formatter');
});

test('changing the JSON declaration reruns only the formatter, never the step before it', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  await run(ws);
  await writeConfig(ws, { steps: { '1.1': { json: { ...roles, items: { type: 'object', required: ['role'] } } } } });
  const out = (await cli(['run', ws.dir, '1.2.1', '--cache'], ws.dir)).output;
  assert.match(out, /^ {2}1\.1 +cached/m, 'the step is not asked again');
  assert.match(out, /^ {2}1\.1 json +ran +\S+ +\(its JSON declaration changed\)/m);
  assert.deepEqual(await countByStep(ws.log), { '1.1': 1, '1.2.1': 2, '1.2.2': 1, '1.2.3': 1 });
  assert.equal((await calls(ws.flog)).length, 2);
  // Another formatter command is another result.
  await writeConfig(ws, { formatter: formatterCommand(ws.flog, ['--other']), steps: { '1.1': { json: { ...roles, items: { type: 'object', required: ['role'] } } } } });
  assert.match((await cli(['run', ws.dir, '1.2.1', '--cache'], ws.dir)).output, /^ {2}1\.1 json +ran +\S+ +\(its formatter command changed\)/m);
  // A declaration the stored text no longer satisfies fails instead of being reused.
  await writeConfig(ws, { formatter: formatterCommand(ws.flog, ['--other']), steps: { '1.1': { json: { type: 'array', minItems: 4 } } } });
  assert.equal((await run(ws, ['1.1'])).error.code, 'OUTPUT_JSON_INVALID');
});

test('removing a JSON declaration drops the formatter; the step itself stays cached', async t => {
  const ws = await jsonWorkspace(t, { '1.1-a.md': 'OUTPUT::[1,2]', '1.2-b.md': 'OUTPUT::done' }, { steps: { '1.1': { json: true } } });
  await run(ws);
  await writeConfig(ws, {});
  const out = (await cli(['run', ws.dir, '1.2'], ws.dir)).output;
  assert.match(out, /^ {2}1\.1 +cached/m);
  assert.ok(!/1\.1 json/.test(out), 'no formatter any more');
  assert.equal((await calls(ws.flog)).length, 1);
});

test('a step that runs again makes its formatter run again; a tampered formatter result reruns only the formatter', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, config);
  const first = await run(ws);
  await put(ws.dir, '1.1-roles.md', `OUTPUT::${THREE} `); // a new answer
  const second = (await cli(['run', ws.dir, '1.2.1', '--cache'], ws.dir)).output;
  assert.match(second, /^ {2}1\.1 +ran +\S+ +\(its prompt file changed\)/m);
  assert.match(second, /^ {2}1\.1 json +ran +\S+ +\(the step's text changed\)/m);
  const latest = JSON.parse((await cli(['run', ws.dir, '1.2.1', '--cache', '--json'], ws.dir)).output);
  await writeFile(latest.steps['1.1'].format.artifact, 'tampered');
  const third = await run(ws, ['--cache']);
  assert.ok(third.events.some(event => event.type === 'CACHE_INVALID' && event.address === '1.1~json'));
  assert.equal(third.status, 'COMPLETED');
  assert.equal(third.steps['1.1'].format.attempts, 1, 'the formatter ran again');
  assert.ok(third.steps['1.1'].reused, 'the step itself did not');
  assert.ok(first.runId);
});

test('--retry covers the formatter: a timeout is an unknown outcome, and the hint says so', async t => {
  const { files, config } = scenario();
  const ws = await jsonWorkspace(t, files, { ...config, timeout: 0.4 });
  await put(ws.dir, 'formatter.slow', 'x');
  const timedOut = await cli(['run', ws.dir], ws.dir);
  assert.equal(timedOut.code, 1);
  assert.match(timedOut.output, /^ {2}1\.1 json +FAILED +Command timed out after 0\.4s\. Raise it with --timeout <seconds> or "timeout" in awe\.json\. The command may have acted before it was stopped, so run again with --retry 1\.1\./m);
  assert.match(timedOut.output, /^Next {2}awe run --cache --timeout 1 --retry 1\.1 {4}\(formatter limit now 0\.4s\)/m);
  await rm(path.join(ws.dir, 'formatter.slow'));
  const refused = await run(ws, ['--cache']);
  assert.equal(refused.error.code, 'UNKNOWN_EFFECT');
  assert.match(refused.error.message, /^The formatter of step 1\.1 has an unknown outcome/);
  const fixed = await run(ws, ['--cache', '--retry', '1.1']);
  assert.equal(fixed.status, 'COMPLETED', JSON.stringify(fixed.error));
  assert.equal((await countByStep(ws.log))['1.1'], 1, 'the step was never asked again');
});

// ── in flows ────────────────────────────────────────────────────────────────
test('an IF gate can read a field of a JSON step', async t => {
  const ws = await jsonWorkspace(t, {
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
