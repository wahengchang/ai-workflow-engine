import { renderTemplate, templateReferences } from './template.js';
import { flatten } from './discover.js';

// The prompt a step sends is its own file, rendered, and nothing else: no headers, no preamble. The
// shared text from awe.json "common" appears only where a prompt writes {{ common }}. Shared by awe run
// and awe run --dry so both build byte-identical prompts.
export function buildPrompt(entry, source, context, node) {
  const usesCommon = templateReferences(source).some(reference => reference.isCommon);
  const common = usesCommon && entry.common !== undefined
    ? renderTemplate(entry.common.trim(), { input: context.input, steps: {} }, `${entry.commonLabel} (used by step ${node.id})`)
    : undefined;
  return renderTemplate(source, { ...context, common }, node.relative);
}

export function gateValue(value, config, expected = false) {
  // Preserve v0.1's exact expected value unless normalization is requested.
  let result = expected && config.match !== 'first-line' ? value : value.trim();
  if (config.match === 'first-line') {
    result = result.split(/\r?\n/, 1)[0].trim();
    const wrapped = /^(\*\*|__|`|\*|_)(.+)\1$/.exec(result);
    if (wrapped) result = wrapped[2].trim();
  }
  return config.caseInsensitive ? result.toLowerCase() : result;
}

export function getPlan(tree) {
  return flatten(tree).map(node => ({ type: node.type, id: node.id ?? '', path: node.relative || '.', config: node.type === 'if' || node.type === 'loop' ? node.config : undefined }));
}
