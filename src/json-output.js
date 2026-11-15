import { AweError } from './errors.js';

// A step may declare the JSON it should produce (awe.json: "steps": { "1.1": { "json": ... } }). The step
// itself answers in free text; a second command, the formatter, turns that text into JSON. awe parses the
// formatter's output and checks it against the declaration before the step counts as done, so a later prompt
// can read {{ steps["1.1"].json[0].role }} and a bad answer stops the workflow where it happened.
//
// The declaration is `true` (any JSON) or a small, JSON-Schema-style description. Only the keywords below
// exist; anything else is rejected when awe.json is read, so a typo is never silently ignored.
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
// `description` is only a hint for whoever produces the JSON (the formatter's prompt, a native --json-schema).
const KEYWORDS = ['type', 'items', 'minItems', 'maxItems', 'required', 'properties', 'enum', 'additionalProperties', 'description'];

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Validates a declaration (the value of "json") and returns it as a schema object. `true` means any JSON.
export function normalizeJsonDeclaration(value, where) {
  if (value === true) return {};
  const bad = message => new AweError('INVALID_CONFIG', `awe.json ${where}: ${message}`);
  if (!isPlainObject(value)) throw bad('"json" must be true (any JSON) or an object such as { "type": "array", "minItems": 3, "maxItems": 3 }');
  const check = (schema, at) => {
    if (!isPlainObject(schema)) throw bad(`${at} must be an object`);
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.includes(key)) throw bad(`${at} has unsupported key "${key}". Supported: ${KEYWORDS.join(', ')}`);
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.length || !types.every(type => TYPES.includes(type))) throw bad(`${at}.type must be one of ${TYPES.join(', ')} (or a list of them)`);
    }
    for (const key of ['minItems', 'maxItems']) {
      if (schema[key] !== undefined && !(Number.isInteger(schema[key]) && schema[key] >= 0)) throw bad(`${at}.${key} must be a non-negative integer`);
    }
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) throw bad(`${at}.minItems is larger than maxItems`);
    if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every(name => typeof name === 'string' && name))) throw bad(`${at}.required must be a list of field names`);
    if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length)) throw bad(`${at}.enum must be a non-empty list`);
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw bad(`${at}.additionalProperties must be true or false`);
    if (schema.description !== undefined && typeof schema.description !== 'string') throw bad(`${at}.description must be a string`);
    if (schema.items !== undefined) check(schema.items, `${at}.items`);
    if (schema.properties !== undefined) {
      if (!isPlainObject(schema.properties)) throw bad(`${at}.properties must be an object of field -> schema`);
      for (const [name, child] of Object.entries(schema.properties)) check(child, `${at}.properties.${name}`);
    }
  };
  check(value, '"json"');
  return value;
}

const kindOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);
const matchesType = (value, type) => kindOf(value) === type || (type === 'number' && kindOf(value) === 'integer');
const at = path => path.join('') || '$';
const preview = value => { const text = JSON.stringify(value); return text.length > 40 ? `${text.slice(0, 37)}...` : text; };

// JSON objects are unordered; arrays retain their order. Compare values, not their serialization.
function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}

// Returns a list of readable problems (empty when the value fits), e.g. `$[1].perspective is required`.
export function jsonProblems(value, schema, path = ['$']) {
  const problems = [];
  const here = at(path);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) problems.push(`${here} must be ${types.join(' or ')}, got ${kindOf(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(option => sameJson(option, value))) {
    problems.push(`${here} must be one of ${schema.enum.map(preview).join(', ')}, got ${preview(value)}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${here} must have ${schema.minItems === schema.maxItems ? 'exactly' : 'at least'} ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}, got ${value.length}`);
    else if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${here} must have ${schema.minItems === schema.maxItems ? 'exactly' : 'at most'} ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}, got ${value.length}`);
    if (schema.items !== undefined) value.forEach((item, index) => problems.push(...jsonProblems(item, schema.items, [...path, `[${index}]`])));
  } else if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) problems.push(`${at([...path, `.${name}`])} is required`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) problems.push(...jsonProblems(value[name], child, [...path, `.${name}`]));
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, name)) problems.push(`${at([...path, `.${name}`])} is not allowed`);
      }
    }
  }
  return problems;
}

// Step output (text) -> parsed JSON, or an AweError that says what was wrong with the output.
// The whole output must be JSON: a Markdown code fence, or any text before or after it, is an error.
export function parseJsonOutput(text, stepId, who = `Step ${stepId}`) {
  const body = text.replace(/^﻿/, '').trim();
  const sample = body.length > 160 ? `${body.slice(0, 160)}...` : body;
  if (!body) throw new AweError('OUTPUT_NOT_JSON', `${who} must output JSON, but its output is empty.`);
  try {
    return JSON.parse(body);
  } catch (error) {
    const hint = body.startsWith('```')
      ? 'The output is wrapped in a Markdown code fence.'
      : /^[^[{"\d\-tfn]/.test(body) ? 'The output starts with text before the JSON.' : `(${error.message})`;
    throw new AweError('OUTPUT_NOT_JSON', `${who} must output JSON only, but its output is not valid JSON. ${hint}\nThe command must reply with the JSON alone: no Markdown code fence, no text before or after it.\nOutput starts with: ${JSON.stringify(sample)}`);
  }
}

export function checkJsonOutput(value, schema, stepId, what = `The JSON output of step ${stepId}`) {
  const problems = jsonProblems(value, schema);
  if (!problems.length) return;
  const shown = problems.slice(0, 5);
  throw new AweError('OUTPUT_JSON_INVALID', `${what} does not match its declaration in awe.json:\n  ${shown.join('\n  ')}${problems.length > shown.length ? `\n  (${problems.length - shown.length} more)` : ''}`);
}

// Parse and check in one go; returns the parsed value.
export function readJsonOutput(text, schema, stepId, who) {
  const value = parseJsonOutput(text, stepId, who);
  checkJsonOutput(value, schema, stepId, who ? `The JSON made by ${who.replace(/^The /, 'the ')}` : undefined);
  return value;
}

// ── the formatter's prompt ──────────────────────────────────────────────────
// Fixed on purpose: one prompt, so every tool behaves alike. Bump the version when the wording changes, so
// results made with an older wording are recognised (it is part of the formatter step's fingerprint).
export const FORMAT_PROMPT_VERSION = 1;
export const TEXT_START = '--- TEXT START ---';
export const TEXT_END = '--- TEXT END ---';

export function buildFormatPrompt(text, schema) {
  return [
    'Convert the text between the TEXT markers into JSON that matches the schema.',
    '',
    'Rules:',
    '- Reply with the JSON only: no Markdown code fence, no explanation, no text before or after it.',
    '- Use only what the text says. Do not invent values. Keep the language of the text for string values.',
    '- Follow the schema exactly: its types, required fields, item counts and allowed values.',
    '',
    'Schema (JSON Schema):',
    JSON.stringify(schema, null, 2),
    '',
    TEXT_START,
    text,
    TEXT_END,
    '',
  ].join('\n');
}
