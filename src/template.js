import { AweError } from './errors.js';

// Intentionally non-Turing-complete. No JavaScript evaluation or property traversal.
const TOKEN = /{{\s*(input\.([A-Za-z_][\w-]*)|steps\[['"](\d+(?:\.\d+)*)['"]\]\.(output|artifact))\s*}}/g;
export function renderTemplate(source, context) {
  const rendered = source.replace(TOKEN, (_match, _expr, inputKey, stepId, field) => {
    let value = inputKey ? context.input?.[inputKey] : context.steps?.[stepId]?.[field];
    if (value === undefined || value === null) throw new AweError('MISSING_REFERENCE', `Missing template value: ${_expr}`);
    if (typeof value === 'object') value = JSON.stringify(value);
    return String(value);
  });
  if (/{{[\s\S]*?}}/.test(rendered)) throw new AweError('INVALID_TEMPLATE', `Unsupported template expression in: ${source.slice(0, 120)}`);
  return rendered;
}
