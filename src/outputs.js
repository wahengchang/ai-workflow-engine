import { assertAwe, AweError } from './errors.js';
import { flatten } from './discover.js';
import { getExecutionMode } from './executor.js';

// Snapshot declarative output IDs before execution; never evaluate source or templates.
export function compileOutputs(config, tree) {
  if (config === undefined) return {};
  assertAwe(config !== null && typeof config === 'object' && !Array.isArray(config), 'INVALID_OUTPUT', 'awe.json outputs must be an object mapping names to prompt step IDs');
  const prompts = new Set(flatten(tree).filter(node => node.type === 'prompt').map(node => node.id));
  return Object.fromEntries(Object.entries(config).map(([name, value]) => {
    assertAwe(/^[A-Za-z_][\w-]*$/.test(name), 'INVALID_OUTPUT', `Invalid output name: ${name}`);
    const ids = Array.isArray(value) ? [...value] : [value];
    assertAwe(ids.length > 0 && ids.every(id => typeof id === 'string' && prompts.has(id)), 'INVALID_OUTPUT', `Output ${name} must reference existing prompt step IDs`);
    assertAwe(new Set(ids).size === ids.length, 'INVALID_OUTPUT', `Output ${name} repeats a candidate step ID`);
    return [name, ids];
  }));
}

export function resolveOutputs(definitions, steps) {
  return Object.fromEntries(Object.entries(definitions).map(([name, ids]) => {
    const completed = ids.filter(id => steps[id]?.status === 'COMPLETED' && typeof steps[id]?.artifact === 'string');
    if (completed.length === 0) throw new AweError('OUTPUT_NOT_FOUND', `Output ${name} has no completed candidate step (${ids.join(', ')})`);
    if (completed.length > 1) throw new AweError('OUTPUT_AMBIGUOUS', `Output ${name} has multiple completed candidate steps (${completed.join(', ')})`);
    const stepId = completed[0];
    return [name, { stepId, attempt: steps[stepId].attempts, artifact: steps[stepId].artifact }];
  }));
}

export function getOutputs(state) {
  const artifacts = Object.entries(state.steps ?? {})
    .filter(([, step]) => step.status === 'COMPLETED' && typeof step.artifact === 'string')
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([stepId, step]) => ({ stepId, attempt: step.attempts, artifact: step.artifact }));
  return {
    runId: state.runId,
    status: state.status,
    executionMode: state.executionMode ?? getExecutionMode(state.executor),
    complete: state.status === 'COMPLETED',
    outputDefinitions: state.outputDefinitions ?? {},
    outputs: state.status === 'COMPLETED' ? state.outputs ?? {} : {},
    artifacts,
  };
}
