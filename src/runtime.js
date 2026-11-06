import { readFile } from 'node:fs/promises';
import { AweError, assertAwe } from './errors.js';
import { renderTemplate } from './template.js';
import { executePrompt } from './executor.js';
import { RunStore } from './storage.js';
import { flatten } from './discover.js';

export async function startRun(entry, tree, options = {}) {
  const executor = options.executor ?? entry.config.executor ?? { type: 'echo' };
  assertAwe(['echo', 'command'].includes(executor.type), 'INVALID_EXECUTOR', 'Unknown executor type');
  const store = new RunStore(entry.root);
  const state = {
    version: 1, runId: store.runId, workflow: entry.root, status: 'RUNNING',
    startedAt: new Date().toISOString(), finishedAt: null,
    executor: { type: executor.type, executable: executor.type === 'command' ? executor.argv?.[0] : undefined },
    input: { ...(entry.config.input ?? {}), ...(options.input ?? {}) },
    steps: {}, events: [], error: null,
  };
  const shared = { state, store, entry, signal: options.signal, executor: { ...executor, cwd: entry.root, signal: options.signal } };
  await store.initialize(state);
  const context = { input: state.input, steps: {} };
  try {
    await executeGroup(tree, context, shared);
    if (shared.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
    state.status = 'COMPLETED';
  } catch (error) {
    state.status = error.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED';
    state.error = { code: error.code ?? 'UNEXPECTED', message: error.message };
    shared.state.events.push({ at: new Date().toISOString(), type: state.status === 'INTERRUPTED' ? 'RUN_INTERRUPTED' : 'RUN_FAILED', detail: state.error });
  } finally {
    state.finishedAt = new Date().toISOString();
    await store.save(state);
  }
  return state;
}

function event(shared, type, node, info = {}) {
  shared.state.events.push({ at: new Date().toISOString(), type, node: node?.id ?? node?.relative ?? '', ...info });
}

async function executePromptStep(node, context, shared) {
  const id = node.id;
  const current = shared.state.steps[id] ?? { attempts: 0 };
  const attempt = current.attempts + 1;
  const prior = { ...current };
  shared.state.steps[id] = { ...prior, attempts: attempt, status: 'RUNNING', source: node.relative };
  event(shared, 'STEP_STARTED', node, { attempt });
  await shared.store.save(shared.state);
  try {
    const source = await readFile(node.file, 'utf8');
    const compiled = renderTemplate(source, context);
    const instructions = renderTemplate(shared.entry.instructions, context);
    const prompt = `# Workflow instructions (ENTRY.md)\n${instructions}\n\n# Step ${id} (${node.relative})\n${compiled}\n`;
    if (shared.entry.config.storePrompts === true) {
      shared.state.steps[id].prompt = await shared.store.prompt(id, attempt, prompt);
    }
    const output = await executePrompt(prompt, shared.executor);
    assertAwe(typeof output === 'string', 'INVALID_RESULT', `Step ${id} produced invalid output`);
    const artifact = await shared.store.artifact(id, attempt, output);
    context.steps[id] = { output, artifact };
    shared.state.steps[id] = { ...shared.state.steps[id], status: 'COMPLETED', attempts: attempt, source: node.relative, artifact, outputPreview: output.slice(0, 200) };
    event(shared, 'STEP_COMPLETED', node, { attempt, artifact });
    await shared.store.save(shared.state);
  } catch (error) {
    shared.state.steps[id] = { ...shared.state.steps[id], status: error.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED', error: { code: error.code ?? 'UNEXPECTED', message: error.message } };
    event(shared, error.code === 'RUN_INTERRUPTED' ? 'STEP_INTERRUPTED' : 'STEP_FAILED', node, { attempt, code: error.code ?? 'UNEXPECTED', message: error.message });
    await shared.store.save(shared.state);
    throw error;
  }
}

async function executeGroup(node, context, shared) {
  if (shared.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
  if (node.type === 'prompt') return executePromptStep(node, context, shared);
  if (node.type === 'sequence') {
    for (const child of node.children) await executeGroup(child, context, shared);
    return;
  }
  if (node.type === 'parallel') {
    // Siblings see the same upstream snapshot; their outputs are only published after JOIN.
    const snapshot = { ...context.steps };
    const branches = node.children.map(child => {
      const local = { input: context.input, steps: { ...snapshot } };
      return { child, local, promise: executeGroup(child, local, shared) };
    });
    const results = await Promise.allSettled(branches.map(b => b.promise));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    const writes = new Map();
    for (const branch of branches) {
      for (const [id, result] of Object.entries(branch.local.steps)) {
        if (snapshot[id] === result) continue;
        if (writes.has(id)) throw new AweError('PARALLEL_COLLISION', `Parallel branches both write step ${id}`);
        writes.set(id, result);
      }
    }
    for (const [id, result] of writes) context.steps[id] = result;
    event(shared, 'PARALLEL_JOIN', node, { branches: branches.length });
    return;
  }
  if (node.type === 'if') {
    const actual = gateValue(renderTemplate(node.config.test, context), node.config);
    const matches = actual === gateValue(node.config.equals, node.config, true);
    if (!matches && node.config.elseEquals !== undefined && actual !== gateValue(node.config.elseEquals, node.config, true)) {
      throw new AweError('IF_NO_MATCH', `IF ${node.relative} matched neither equals nor elseEquals`);
    }
    const branch = matches ? node.config.then : node.config.else;
    event(shared, 'IF_BRANCH', node, { actual, expected: node.config.equals, branch });
    const chosen = node.children.find(n => n.branch === branch);
    assertAwe(chosen, 'INVALID_FLOW', `Missing branch ${branch} in ${node.relative}`);
    return executeGroup(chosen, context, shared);
  }
  if (node.type === 'loop') {
    for (let i = 1; i <= node.config.maxIterations; i++) {
      event(shared, 'LOOP_ITERATION', node, { iteration: i });
      for (const child of node.children) await executeGroup(child, context, shared);
      const actual = gateValue(renderTemplate(node.config.until, context), node.config);
      if (actual === gateValue(node.config.equals, node.config, true)) {
        event(shared, 'LOOP_COMPLETED', node, { iteration: i });
        return;
      }
    }
    throw new AweError('LOOP_EXHAUSTED', `Loop ${node.relative} did not match exit condition after ${node.config.maxIterations} iterations`);
  }
  throw new AweError('INVALID_FLOW', `Unsupported flow type ${node.type}`);
}

function gateValue(value, config, expected = false) {
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
