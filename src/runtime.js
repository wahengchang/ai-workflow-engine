import { renderTemplate } from './template.js';
import { flatten } from './discover.js';

// The prompt a step sends: ENTRY.md instructions, then the step. Shared by awe run and awe run --dry
// so both build byte-identical prompts.
export function buildPrompt(entry, source, context, node) {
  const compiled = renderTemplate(source, context, node.relative);
  const instructions = renderTemplate(entry.instructions, context, `ENTRY.md (while preparing step ${node.id})`);
  return `# Workflow instructions (ENTRY.md)\n${instructions}\n\n# Step ${node.id} (${node.relative})\n${compiled}\n`;
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
