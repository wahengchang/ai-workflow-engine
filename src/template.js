import { AweError } from './errors.js';

// Parse only author-written source. Inserted data is never parsed as a template.
const STEP = /^steps\[(['"])(\d+(?:\.\d+)*)\1\]\.(.+)$/s;
// A path into a step's JSON output: .key  [0]  ["key"]  and nothing else. No expressions, no calls.
const JSON_SEGMENT = /^(?:\.([A-Za-z_][\w-]*)|\[(\d+)\]|\[(['"])((?:(?!\3)[^\\])+)\3\])/;

function parseJsonPath(text) {
  const segments = [];
  let rest = text;
  while (rest) {
    const match = JSON_SEGMENT.exec(rest);
    if (!match) return null;
    segments.push(match[1] !== undefined ? { key: match[1] } : match[2] !== undefined ? { index: Number(match[2]) } : { key: match[4] });
    rest = rest.slice(match[0].length);
  }
  return segments;
}

// Returns the parsed reference, or null when the text is not a supported expression.
function parseExpression(raw) {
  const text = raw.trim();
  if (text === 'common') return { expression: text, isCommon: true };
  const input = /^input\.([A-Za-z_][\w-]*)$/.exec(text);
  if (input) return { expression: text, inputKey: input[1] };
  const step = STEP.exec(text);
  if (!step) return null;
  const [, , stepId, tail] = step;
  if (tail === 'output' || tail === 'artifact') return { expression: text, stepId, field: tail };
  const file = /^files\[(['"])([A-Za-z][\w-]*)\1\]$/.exec(tail);
  if (file) return { expression: text, stepId, field: 'files', fileName: file[2] };
  if (tail === 'json' || tail.startsWith('json.') || tail.startsWith('json[')) {
    const path = parseJsonPath(tail.slice('json'.length));
    if (path) return { expression: text, stepId, field: 'json', jsonPath: path };
  }
  return null;
}

function parseTemplate(source) {
  const parts = [];
  let end = 0;
  for (const token of source.matchAll(/\\{{|{{([\s\S]*?)}}|{{/g)) {
    parts.push(source.slice(end, token.index));
    end = token.index + token[0].length;
    if (token[0] === '\\{{') {
      parts.push('{{');
      continue;
    }
    const reference = token[1] === undefined ? null : parseExpression(token[1]);
    if (!reference) throw new AweError('INVALID_TEMPLATE', `Unsupported or unclosed template at line ${source.slice(0, token.index).split('\n').length}: ${token[0].slice(0, 120)}`);
    parts.push(reference);
  }
  parts.push(source.slice(end));
  return parts;
}

// "steps[\"1.1\"].json[0].role": the text used in error messages for a reference into JSON.
const pathText = segments => segments.map(segment => (segment.index !== undefined ? `[${segment.index}]` : `.${segment.key}`)).join('');

// Walks a parsed JSON value along the segments of a reference. Plain data only: own properties, array indexes.
function jsonValue(value, reference, where) {
  const trail = [];
  let current = value;
  for (const segment of reference.jsonPath) {
    const here = `json${pathText(trail)}`;
    if (segment.index !== undefined) {
      if (!Array.isArray(current)) throw new AweError('MISSING_REFERENCE', `Missing template value: ${reference.expression}. ${where} is not an array at ${here}; it is ${describe(current)}`);
      if (segment.index >= current.length) throw new AweError('MISSING_REFERENCE', `Missing template value: ${reference.expression}. Index ${segment.index} is out of range at ${here}: the array has ${current.length} item${current.length === 1 ? '' : 's'}`);
      current = current[segment.index];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new AweError('MISSING_REFERENCE', `Missing template value: ${reference.expression}. ${where} is not an object at ${here}; it is ${describe(current)}`);
      if (!Object.hasOwn(current, segment.key)) {
        const keys = Object.keys(current);
        throw new AweError('MISSING_REFERENCE', `Missing template value: ${reference.expression}. There is no "${segment.key}" at ${here}${keys.length ? ` (it has: ${keys.slice(0, 12).join(', ')})` : ''}`);
      }
      current = current[segment.key];
    }
    trail.push(segment);
  }
  return current;
}

const describe = value => (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value === 'object' ? 'an object' : `a ${typeof value}`);

// Prefix template errors with where the source lives (file or step) so authors can find them.
function labelled(label, fn) {
  try {
    return fn();
  } catch (error) {
    if (label && error instanceof AweError && ['INVALID_TEMPLATE', 'MISSING_REFERENCE'].includes(error.code)) error.message = `${label}: ${error.message}`;
    throw error;
  }
}

export function validateTemplate(source, label) {
  labelled(label, () => parseTemplate(source));
}

export function templateReferences(source, label) {
  return labelled(label, () => parseTemplate(source).filter(part => typeof part !== 'string'));
}

export function renderTemplate(source, context, label) {
  return labelled(label, () => parseTemplate(source).map(part => {
    if (typeof part === 'string') return part;
    let value;
    if (part.field === 'json') {
      const step = context.steps?.[part.stepId];
      // `awe run --dry` has no results: show where the value would come from.
      if (step?.dry) return `[json of ${part.stepId}${pathText(part.jsonPath)}]`;
      if (step === undefined) throw new AweError('MISSING_REFERENCE', `Missing template value: ${part.expression}`);
      if (!('json' in step)) throw new AweError('MISSING_REFERENCE', `Missing template value: ${part.expression}. Step ${part.stepId} has no JSON output; declare it in awe.json: "steps": { "${part.stepId}": { "json": true } }`);
      value = jsonValue(step.json, part, `The JSON output of step ${part.stepId}`);
    } else {
      value = part.isCommon ? context.common
        : part.inputKey ? context.input?.[part.inputKey]
        : part.fileName ? context.steps?.[part.stepId]?.files?.[part.fileName]
          : context.steps?.[part.stepId]?.[part.field];
    }
    if (value === undefined || value === null) throw new AweError('MISSING_REFERENCE', `Missing template value: ${part.expression}`);
    if (typeof value === 'object') value = JSON.stringify(value);
    return String(value);
  }).join(''));
}
