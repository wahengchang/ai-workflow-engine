import { readFile } from 'node:fs/promises';
import { AweError } from './errors.js';
import { flatten } from './discover.js';
import { buildPrompt } from './runtime.js';
import { declaredOutputs } from './outputs.js';

// `awe run --dry`: render prompts without calling anything. Upstream results do not exist, so a
// reference such as {{ steps["1.1"].output }} renders as "[output of 1.1]". Every IF branch is shown
// and a LOOP body is shown once. Nothing is written: no run, no cache.
export async function dryRun(entry, tree, { input = {}, step } = {}) {
  const outputs = declaredOutputs(entry.config, tree);
  const prompts = flatten(tree).filter(node => node.type === 'prompt');
  if (step !== undefined && !prompts.some(node => node.id === step)) {
    throw new AweError('STEP_NOT_FOUND', `No step "${step}". Steps: ${prompts.slice(0, 20).map(node => node.id).join('  ')}   (see: awe check)`);
  }
  const context = { input: { ...(entry.config.input ?? {}), ...input }, steps: {} };
  const rendered = [];
  for (const node of prompts) {
    const prompt = buildPrompt(entry, await readFile(node.file, 'utf8'), context, node);
    if (step === undefined || node.id === step) rendered.push({ id: node.id, source: node.relative, prompt });
    context.steps[node.id] = {
      output: `[output of ${node.id}]`,
      artifact: `[artifact of ${node.id}]`,
      files: Object.fromEntries((outputs.get(node.id) ?? []).map(decl => [decl.name, `[file ${decl.name} of ${node.id}]`])),
    };
  }
  return rendered;
}
