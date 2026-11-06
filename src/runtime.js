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
    executor: { type: executor.type, argv: executor.argv?.map((v, i) => i === 0 ? v : v) },
    input: { ...(entry.config.input ?? {}), ...(options.input ?? {}) },
    steps: {}, events: [], error: null,
  };
  const shared = { state, store, entry, executor: { ...executor, cwd: entry.root } };
  await store.initialize(state);
  const context = { input: state.input, steps: {} };
  try {
    await executeGroup(tree, context, shared);
    state.status = 'COMPLETED';
  } catch (error) {
    state.status = 'FAILED';
    state.error = { code: error.code ?? 'UNEXPECTED', message: error.message };
    shared.state.events.push({ at: new Date().toISOString(), type: 'RUN_FAILED', detail: state.error });
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
    const prompt = `# Workflow instructions (ENTRY.md)\n${shared.entry.instructions}\n\n# Step ${id} (${node.relative})\n${compiled}\n`;
    const output = await executePrompt(prompt, shared.executor);
    assertAwe(typeof output === 'string', 'INVALID_RESULT', `Step ${id} produced invalid output`);
    const artifact = await shared.store.artifact(id, attempt, output);
    context.steps[id] = { output, artifact };
    shared.state.steps[id] = { status: 'COMPLETED', attempts: attempt, source: node.relative, artifact, outputPreview: output.slice(0, 200) };
    event(shared, 'STEP_COMPLETED', node, { attempt, artifact });
    await shared.store.save(shared.state);
  } catch (error) {
    shared.state.steps[id] = { ...shared.state.steps[id], status: 'FAILED', error: { code: error.code ?? 'UNEXPECTED', message: error.message } };
    event(shared, 'STEP_FAILED', node, { attempt, code: error.code ?? 'UNEXPECTED', message: error.message });
    await shared.store.save(shared.state);
    throw error;
  }
}

async function executeGroup(node, context, shared) {
  if (node.type === 'prompt') return executePromptStep(node, context, shared);
  if (node.type === 'sequence') {
    for (const child of node.children) await executeGroup(child, context, shared);
    return;
  }
  if (node.type === 'parallel') {
    // Siblings see the same upstream snapshot; their outputs are only published after JOIN.
    const branches = node.children.map(child => {
      const local = { input: context.input, steps: { ...context.steps } };
      return { child, local, promise: executeGroup(child, local, shared) };
    });
    const results = await Promise.allSettled(branches.map(b => b.promise));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    for (const branch of branches) {
      for (const [id, result] of Object.entries(branch.local.steps)) {
        if (context.steps[id] && context.steps[id] !== result) throw new AweError('PARALLEL_COLLISION', `Parallel branches both write step ${id}`);
        context.steps[id] = result;
      }
    }
    event(shared, 'PARALLEL_JOIN', node, { branches: branches.length });
    return;
  }
  if (node.type === 'if') {
    const actual = renderTemplate(node.config.test, context).trim();
    const branch = actual === node.config.equals ? node.config.then : node.config.else;
    event(shared, 'IF_BRANCH', node, { actual, expected: node.config.equals, branch });
    const chosen = node.children.find(n => n.branch === branch);
    assertAwe(chosen, 'INVALID_FLOW', `Missing branch ${branch} in ${node.relative}`);
    return executeGroup(chosen, context, shared);
  }
  if (node.type === 'loop') {
    for (let i = 1; i <= node.config.maxIterations; i++) {
      event(shared, 'LOOP_ITERATION', node, { iteration: i });
      for (const child of node.children) await executeGroup(child, context, shared);
      const actual = renderTemplate(node.config.until, context).trim();
      if (actual === node.config.equals) {
        event(shared, 'LOOP_COMPLETED', node, { iteration: i });
        return;
      }
    }
    throw new AweError('LOOP_EXHAUSTED', `Loop ${node.relative} did not match exit condition after ${node.config.maxIterations} iterations`);
  }
  throw new AweError('INVALID_FLOW', `Unsupported flow type ${node.type}`);
}

export function getPlan(tree) {
  return flatten(tree).map(node => ({ type: node.type, id: node.id ?? '', path: node.relative || '.', config: node.type === 'if' || node.type === 'loop' ? node.config : undefined }));
}
