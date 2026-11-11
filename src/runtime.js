import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';
import { renderTemplate } from './template.js';
import { executePrompt, getExecutionMode } from './executor.js';
import { RunStore, sha256 } from './storage.js';
import { flatten } from './discover.js';
import { assertOutputLocations, declaredOutputs, snapshotOutputs, captureOutputs, simulatedFiles, filePaths } from './outputs.js';
import { computeFingerprints } from './partial.js';

// Shared by awe run and awe dev so both build byte-identical prompts.
export function buildPrompt(entry, source, context, node) {
  const compiled = renderTemplate(source, context, node.relative);
  const instructions = renderTemplate(entry.instructions, context, `ENTRY.md (while preparing step ${node.id})`);
  return `# Workflow instructions (ENTRY.md)\n${instructions}\n\n# Step ${node.id} (${node.relative})\n${compiled}\n`;
}

export async function startRun(entry, tree, options = {}) {
  const executor = options.executor ?? entry.config.executor ?? { type: 'echo' };
  assertAwe(['echo', 'command'].includes(executor.type), 'INVALID_EXECUTOR', 'Unknown executor type');
  const outputs = declaredOutputs(entry.config, tree);
  await assertOutputLocations(entry.root, tree, outputs);
  const store = new RunStore(entry.root);
  const partial = options.partial;
  const state = {
    version: 1, runId: store.runId, workflow: entry.root, status: 'RUNNING',
    executionMode: getExecutionMode(executor),
    startedAt: new Date().toISOString(), finishedAt: null,
    executor: { type: executor.type, executable: executor.type === 'command' ? executor.argv?.[0] : undefined },
    input: { ...(entry.config.input ?? {}), ...(options.input ?? {}) },
    // Snapshot where each input value came from, so a later partial rerun can
    // compare defaults against the current awe.json while carrying --var values.
    // Partial runs inherit the source's --var provenance (current defaults are
    // already verified unchanged by the caller).
    inputSource: options.inputSource ?? { defaults: { ...(entry.config.input ?? {}) }, vars: { ...(options.input ?? {}) } },
    steps: {}, events: [], error: null,
  };
  if (partial) {
    // Provenance is persisted on the new run before execution starts.
    state.parentRunId = partial.parentRunId;
    state.from = partial.from;
    state.reusedSteps = [...partial.reusedSteps];
  }
  const shared = { state, store, entry, outputs, signal: options.signal, executor: { ...executor, cwd: entry.root, signal: options.signal } };
  await store.initialize(state);
  const context = { input: state.input, steps: {} };
  try {
    if (partial) {
      // Seed only upstream steps the source executed before the cut; context
      // references point at fresh copies inside this run, never old paths.
      for (const seedStep of partial.seeds) {
        const content = seedStep.output;
        const artifact = await shared.store.copyArtifact(seedStep.id, seedStep.attempts, content);
        let files;
        if (seedStep.files) {
          const dir = shared.store.fileDir(seedStep.id, seedStep.attempts);
          await mkdir(dir, { recursive: true });
          files = {};
          for (const [name, file] of Object.entries(seedStep.files)) {
            if (file.simulated) {
              files[name] = { ...file };
              continue;
            }
            const destination = path.join(dir, `${name}${path.extname(file.source ?? file.path)}`);
            await copyFile(file.path, destination);
            files[name] = { path: destination, source: file.source, sha256: file.sha256, size: file.size };
          }
        }
        shared.state.steps[seedStep.id] = {
          attempts: seedStep.attempts, status: 'COMPLETED', reused: true, originRunId: partial.parentRunId,
          source: seedStep.source, artifact, outputPreview: content.slice(0, 200), ...(files ? { files } : {}),
        };
        context.steps[seedStep.id] = { output: content, artifact, ...(files ? { files: filePaths(files) } : {}) };
      }
      event(shared, 'PARTIAL_SEEDED', null, { from: partial.from, steps: partial.seeds.length, parentRunId: partial.parentRunId });
      await shared.store.save(shared.state);
    }
    await executeGroup(partial ? partial.startNode : tree, context, shared);
    if (shared.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
    state.status = 'COMPLETED';
  } catch (error) {
    state.status = error.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED';
    state.error = { code: error.code ?? 'UNEXPECTED', message: error.message };
    shared.state.events.push({ at: new Date().toISOString(), type: state.status === 'INTERRUPTED' ? 'RUN_INTERRUPTED' : 'RUN_FAILED', detail: state.error });
  } finally {
    state.finishedAt = new Date().toISOString();
    try {
      state.fingerprints = await finalizeFingerprints(shared, tree);
    } catch (fingerprintError) {
      // A fingerprint failure must not hide the run's terminal state.
      if (!state.error) throw fingerprintError;
    }
    await store.save(state);
  }
  return state;
}

async function finalizeFingerprints(shared, tree) {
  const fingerprints = await computeFingerprints(shared.entry, tree, shared.state.input);
  // Executed artifacts are hashed on completion; reused artifacts were copied
  // byte-identical into this run, so their hashes match the source's records.
  const artifacts = {};
  for (const [id, record] of Object.entries(shared.state.steps)) {
    if (record.status === 'COMPLETED' && record.artifact) {
      artifacts[id] = sha256(await readFile(record.artifact));
    }
  }
  fingerprints.artifacts = artifacts;
  // Declared output files are execution results too; hash the saved copies so a
  // later partial reuse can prove they are intact before seeding them.
  const files = {};
  for (const [id, record] of Object.entries(shared.state.steps)) {
    if (record.status !== 'COMPLETED' || !record.files) continue;
    const hashed = {};
    for (const [name, file] of Object.entries(record.files)) {
      if (file.simulated) continue;
      hashed[name] = sha256(await readFile(file.path));
    }
    if (Object.keys(hashed).length) files[id] = hashed;
  }
  fingerprints.files = files;
  return fingerprints;
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
    const prompt = buildPrompt(shared.entry, source, context, node);
    if (shared.entry.config.storePrompts === true) {
      shared.state.steps[id].prompt = await shared.store.prompt(id, attempt, prompt);
    }
    const decls = shared.outputs.get(id) ?? [];
    const simulated = shared.executor.type === 'echo';
    const before = decls.length && !simulated ? await snapshotOutputs(shared.entry.root, decls) : null;
    const output = await executePrompt(prompt, shared.executor);
    assertAwe(typeof output === 'string', 'INVALID_RESULT', `Step ${id} produced invalid output`);
    const artifact = await shared.store.artifact(id, attempt, output);
    const files = !decls.length ? undefined : simulated ? simulatedFiles(decls)
      : await captureOutputs({ root: shared.entry.root, stepId: id, decls, before, destDir: shared.store.fileDir(id, attempt) });
    context.steps[id] = { output, artifact, ...(files ? { files: filePaths(files) } : {}) };
    shared.state.steps[id] = { ...shared.state.steps[id], status: 'COMPLETED', attempts: attempt, source: node.relative, artifact, outputPreview: output.slice(0, 200), ...(files ? { files } : {}) };
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
    const actual = gateValue(renderTemplate(node.config.test, context, `${node.relative}/FLOW.json (test)`), node.config);
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
      const actual = gateValue(renderTemplate(node.config.until, context, `${node.relative}/FLOW.json (until)`), node.config);
      if (actual === gateValue(node.config.equals, node.config, true)) {
        event(shared, 'LOOP_COMPLETED', node, { iteration: i });
        return;
      }
    }
    throw new AweError('LOOP_EXHAUSTED', `Loop ${node.relative} did not match exit condition after ${node.config.maxIterations} iterations`);
  }
  throw new AweError('INVALID_FLOW', `Unsupported flow type ${node.type}`);
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
