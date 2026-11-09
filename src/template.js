import { AweError } from './errors.js';

// Parse only author-written source. Inserted data is never parsed as a template.
const EXPRESSION = /^\s*(input\.([A-Za-z_][\w-]*)|steps\[(['"])(\d+(?:\.\d+)*)\3\]\.(?:(output|artifact)|files\[(['"])([A-Za-z][\w-]*)\6\]))\s*$/;
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
    const expression = token[1]?.match(EXPRESSION);
    if (!expression) throw new AweError('INVALID_TEMPLATE', `Unsupported or unclosed template at line ${source.slice(0, token.index).split('\n').length}: ${token[0].slice(0, 120)}`);
    parts.push({ expression: expression[1], inputKey: expression[2], stepId: expression[4], field: expression[5] ?? 'files', fileName: expression[7] });
  }
  parts.push(source.slice(end));
  return parts;
}

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
    let value = part.inputKey ? context.input?.[part.inputKey]
      : part.fileName ? context.steps?.[part.stepId]?.files?.[part.fileName]
        : context.steps?.[part.stepId]?.[part.field];
    if (value === undefined || value === null) throw new AweError('MISSING_REFERENCE', `Missing template value: ${part.expression}`);
    if (typeof value === 'object') value = JSON.stringify(value);
    return String(value);
  }).join(''));
}
