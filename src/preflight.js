import { readFile } from 'node:fs/promises';
import { AweError } from './errors.js';
import { templateReferences } from './template.js';
import { assertOutputLocations, declaredOutputs } from './outputs.js';

// Model the first iteration and all possible branches, without executing a gate.
export async function validateReferences(entry, tree, sources = new Map()) {
  // Also validates the awe.json output declarations (including parallel path conflicts).
  const outputs = declaredOutputs(entry.config, tree);
  await assertOutputLocations(entry.root, tree, outputs);
  function check(source, available, label, isCommon = false) {
    for (const reference of templateReferences(source, label)) {
      if (reference.stepId && !available.has(reference.stepId)) {
        const hint = isCommon
          ? '\nThe common text is added to the prompt of every step, including the first, so it can only use {{ input.* }}. Refer to earlier steps from the step\'s own prompt.'
          : '';
        throw new AweError('MISSING_REFERENCE', `${label}: Step ${reference.stepId} is not guaranteed to be available here (unknown, forward, parallel sibling, or conditional reference)${hint}`);
      }
      if (reference.fileName && !outputs.get(reference.stepId)?.some(output => output.name === reference.fileName)) {
        throw new AweError('MISSING_REFERENCE', `${label}: Step ${reference.stepId} does not declare an output file named "${reference.fileName}" in awe.json`);
      }
    }
  }

  async function visit(node, upstream) {
    const available = new Set(upstream);
    if (node.type === 'prompt') {
      check(entry.common ?? '', available, `${entry.commonLabel} (while preparing step ${node.id})`, true);
      check(sources.get(node.file) ?? await readFile(node.file, 'utf8'), available, node.relative);
      available.add(node.id);
      return available;
    }
    if (node.type === 'if') {
      check(node.config.test, available, `${node.relative}/FLOW.json (test)`);
      const branches = await Promise.all(node.children.map(child => visit(child, available)));
      return new Set([...branches[0]].filter(id => branches.every(branch => branch.has(id))));
    }
    if (node.type === 'parallel') {
      const branches = await Promise.all(node.children.map(child => visit(child, available)));
      return new Set(branches.flatMap(branch => [...branch]));
    }
    let result = available;
    for (const child of node.children) result = await visit(child, result);
    if (node.type === 'loop') check(node.config.until, result, `${node.relative}/FLOW.json (until)`);
    return result;
  }
  await visit(tree, new Set());
  return outputs;
}
