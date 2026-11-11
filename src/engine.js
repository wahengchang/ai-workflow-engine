import path from 'node:path';
import { readFile, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AweError, assertAwe } from './errors.js';
import { flatten } from './discover.js';
import { renderTemplate, templateReferences, validateTemplate } from './template.js';
import { executePrompt, needsPromptFile } from './executor.js';
import { RunStore } from './storage.js';
import { buildPrompt, gateValue } from './runtime.js';
import { digestOf, secretDigest, sha256 } from './digest.js';
import { assertOutputLocations, declaredOutputs, snapshotOutputs, captureOutputs, filePaths, verifyStoredFile } from './outputs.js';
import { openSession, workspaceSalt } from './cache.js';

const FINGERPRINT_VERSION = 1;

// ── Addresses ───────────────────────────────────────────────────────────────
// A step ID names the prompt; an *occurrence* names which pass through enclosing LOOPs
// it belongs to; an *attempt* is one execution of an occurrence. Cache slots are per
// occurrence ("1.2" or "1.2@stage-2/2.1-loop=3"); attempts only ever accumulate.
export const loopKey = loops => loops.map(loop => `${loop.rel}=${loop.iter}`).join(',');
export const addressOf = (stepId, loops) => (loops.length ? `${stepId}@${loopKey(loops)}` : stepId);

// What people type and read: "2.1.1" or "2.1.1@2.1" (iteration of each enclosing LOOP, outer to inner).
// The internal cache key keeps the loop paths, so it stays stable if loops are renamed in docs.
export function displayAddress(address) {
  const at = address.indexOf('@');
  if (at < 0) return address;
  return `${address.slice(0, at)}@${[...address.slice(at + 1).matchAll(/=(\d+)/g)].map(m => m[1]).join('.')}`;
}

export function parseStepArg(text) {
  const match = /^(\d+(?:\.\d+)+)(?:@(\d+(?:\.\d+)*))?$/.exec(text);
  if (!match) throw new AweError('CLI_USAGE', `"${text}" is not a step address. Expected something like 1.2 or 2.1.1@2 (see: awe check)`);
  return { step: match[1], iterations: match[2] ? match[2].split('.').map(Number) : undefined };
}

function knownOccurrences(session, stepId) {
  return session.records()
    .filter(record => record.stepId === stepId && record.address.includes('@') && (record.latest || record.pending || record.unknown || record.lastFailure || record.history.length))
    .map(record => record.address);
}

function resolveLoops(target, session) {
  const { stepId, loopNodes, iterations } = target;
  if (!loopNodes.length) {
    assertAwe(iterations === undefined, 'ITERATION_INVALID', `Step ${stepId} is not inside a LOOP, so "@" does not apply. Run: awe run ${stepId}`);
    return [];
  }
  const format = `${stepId}@${loopNodes.map(loop => `<1-${loop.config.maxIterations}>`).join('.')}`;
  if (iterations) {
    assertAwe(iterations.length === loopNodes.length, 'ITERATION_INVALID', `Step ${stepId} is inside ${loopNodes.length} LOOP${loopNodes.length > 1 ? 's (outer to inner)' : ''}. Write it as ${format}`);
    return loopNodes.map((loop, index) => {
      assertAwe(iterations[index] >= 1 && iterations[index] <= loop.config.maxIterations, 'ITERATION_INVALID', `Iteration ${iterations[index]} is outside 1-${loop.config.maxIterations} for loop ${loop.relative}. Write it as ${format}`);
      return { rel: loop.relative, iter: iterations[index] };
    });
  }
  const known = knownOccurrences(session, stepId);
  if (known.length > 1) {
    throw new AweError('ITERATION_REQUIRED', `Step ${stepId} runs inside a LOOP and has several occurrences. Say which: ${format}\nKnown occurrences: ${known.map(displayAddress).sort().join(', ')}`);
  }
  // First time (or a single known occurrence): there is nothing to disambiguate.
  if (known.length === 1) {
    const iters = [...known[0].slice(known[0].indexOf('@') + 1).matchAll(/=(\d+)/g)].map(m => Number(m[1]));
    return loopNodes.map((loop, index) => ({ rel: loop.relative, iter: iters[index] }));
  }
  return loopNodes.map(loop => ({ rel: loop.relative, iter: 1 }));
}

// ── Context ─────────────────────────────────────────────────────────────────
// What a step may legitimately depend on: results of steps that come earlier in
// workflow order. Never the step's own earlier occurrences or later steps, which a
// LOOP can leave in the shared context from a previous pass.
export function precontext(context, ord) {
  return Object.entries(context.steps).filter(([, result]) => result.ord < ord).sort(([a], [b]) => a.localeCompare(b));
}

function indexTree(tree) {
  const info = new Map();
  let ord = 0;
  (function visit(node, loops) {
    info.set(node, { ord: ord++, loops });
    const inner = node.type === 'loop' ? [...loops, node] : loops;
    for (const child of node.children ?? []) visit(child, inner);
  })(tree, []);
  return info;
}

const frameDigest = frame => digestOf([...frame.entries()].sort(([a], [b]) => a.localeCompare(b)));

function event(sh, type, node, extra = {}) {
  sh.state.events.push({ at: new Date().toISOString(), type, node: node?.id ?? node?.relative ?? '', ...extra });
}

const hook = (sh, stage, info) => sh.hooks?.[stage]?.(info);

// ── Entry point ─────────────────────────────────────────────────────────────
// options: {
//   resolveExecutor(stepId) -> { name, argv, display, timeoutMs }   (required)
//   input, signal, hooks,
//   step, iterations      the step to (re)run; omit both for the whole workflow
//   cache                 true: reuse valid results; false: rerun everything. Default: on when a step
//                         is named (you are iterating), off for a whole run (a clean pass)
//   retry                 step addresses whose unknown outcome the user has checked
// }
export async function runWorkflow(entry, tree, options = {}) {
  assertAwe(typeof options.resolveExecutor === 'function', 'INVALID_EXECUTOR', 'runWorkflow needs resolveExecutor');
  // The CLI has already validated the declarations; library callers get them validated here.
  let outputs = options.outputs;
  if (!outputs) {
    outputs = declaredOutputs(entry.config, tree);
    await assertOutputLocations(entry.root, tree, outputs);
  }
  const info = indexTree(tree);
  const nodes = flatten(tree);
  const prompts = nodes.filter(node => node.type === 'prompt');
  // Fail before any state is created if some step has no usable executor.
  for (const node of prompts) options.resolveExecutor(node.id);

  let targetNode = null;
  if (options.step !== undefined) {
    targetNode = prompts.find(node => node.id === options.step);
    if (!targetNode) {
      const group = nodes.find(node => node.type !== 'prompt' && node.id === options.step);
      if (group) {
        const inner = flatten(group).filter(node => node.type === 'prompt').map(node => node.id);
        throw new AweError('STEP_NOT_FOUND', `${options.step} is a ${group.type.toUpperCase()} group, not a step. Run one of its steps, e.g. awe run ${inner[0]}  (steps: ${inner.join(', ')})`);
      }
      const shown = prompts.slice(0, 20).map(node => node.id).join('  ');
      throw new AweError('STEP_NOT_FOUND', `No step "${options.step}". Steps: ${shown}${prompts.length > 20 ? '  ...' : ''}   (see: awe check)`);
    }
  }

  const input = { ...(entry.config.input ?? {}), ...(options.input ?? {}) };
  const salt = await workspaceSalt(entry.root);
  const compat = { root: await realpath(entry.root), input: secretDigest(salt, input) };
  const session = await openSession(entry.root, compat);
  try {
    return await runInSession(entry, tree, { options, outputs, info, targetNode, input, session, salt });
  } finally {
    await session.release();
  }
}

async function runInSession(entry, tree, { options, outputs, info, targetNode, input, session, salt }) {
  // We hold the session lock, so an intent left behind by a dead process is now known to be orphaned.
  await session.reconcile(entry.root);
  const unknown = new Map(session.unknownAddresses().map(address => [displayAddress(address), address]));
  const acknowledged = new Set();
  for (const wanted of options.retry ?? []) {
    assertAwe(unknown.has(wanted), 'RETRY_UNKNOWN',
      `--retry ${wanted} does not match a step with an unknown outcome.${unknown.size ? ` Unknown: ${[...unknown.keys()].join(', ')}` : ' No step needs it.'}`);
    acknowledged.add(unknown.get(wanted));
  }

  let target = null;
  if (targetNode) {
    const loops = resolveLoops({ stepId: targetNode.id, loopNodes: info.get(targetNode).loops, iterations: options.iterations }, session);
    const address = addressOf(targetNode.id, loops);
    target = { node: targetNode, stepId: targetNode.id, loops, address, display: displayAddress(address) };
  }
  const readCache = options.cache ?? Boolean(targetNode);

  // Every command pins its own view of the sources; edits made while it runs apply to the next command.
  const sources = new Map();
  for (const node of flatten(tree)) {
    if (node.type !== 'prompt') continue;
    if (options.sources?.has(node.file)) { sources.set(node.file, options.sources.get(node.file)); continue; }
    const text = await readFile(node.file, 'utf8');
    validateTemplate(text, node.relative);
    sources.set(node.file, text);
  }

  const store = new RunStore(entry.root);
  const state = {
    version: 2, runId: store.runId, workflow: entry.root, status: 'RUNNING',
    startedAt: new Date().toISOString(), finishedAt: null,
    cache: readCache, target: target ? { step: target.stepId, address: target.display } : null, stoppedAfter: null,
    executed: 0, reused: 0, session: session.id,
    input, steps: {}, events: [], invocations: [], error: null,
  };
  const sh = {
    state, store, session, entry, outputs, info, target, sources, readCache, salt,
    signal: options.signal, hooks: options.hooks, acknowledged,
    resolveExecutor: options.resolveExecutor,
    commonDigest: sha256(entry.common ?? ''),
    inputDigest: session.data.compat.input,
    subtrees: new Map(),
  };
  await store.initialize(state);
  const context = { input, steps: {} };
  try {
    await walk(tree, context, sh, { loops: [], control: [], frames: [] });
    if (sh.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
    if (target && !state.stoppedAfter) throw new AweError('TARGET_UNREACHABLE', `Step ${target.display} was not reached by this workflow`);
    state.status = 'COMPLETED';
  } catch (error) {
    state.status = error.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED';
    state.error = { code: error.code ?? 'UNEXPECTED', message: error.message, ...(error.step ? { step: error.step } : {}), ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}) };
    state.events.push({ at: new Date().toISOString(), type: state.status === 'INTERRUPTED' ? 'RUN_INTERRUPTED' : 'RUN_FAILED', detail: state.error });
  } finally {
    state.finishedAt = new Date().toISOString();
    await store.save(state);
    await session.finish(state.runId);
  }
  return state;
}

// ── Walk ────────────────────────────────────────────────────────────────────
function containsTarget(sh, node) {
  if (!sh.target) return false;
  if (!sh.subtrees.has(node)) sh.subtrees.set(node, new Set(flatten(node).filter(n => n.type === 'prompt').map(n => n.id)));
  return sh.subtrees.get(node).has(sh.target.stepId);
}

// The target is "active" for a group when the group contains it AND every LOOP entered so
// far is on the target's own path (same loop, same iteration).
function active(sh, node, scope) {
  return containsTarget(sh, node) && scope.loops.length <= sh.target.loops.length
    && scope.loops.every((loop, i) => loop.rel === sh.target.loops[i].rel && loop.iter === sh.target.loops[i].iter);
}

const extend = (scope, segment) => ({ ...scope, control: [...scope.control, segment] });

// Returns true when the target has just finished and the command must stop.
async function walk(node, context, sh, scope) {
  if (sh.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
  if (node.type === 'prompt') return walkPrompt(node, context, sh, scope);
  if (node.type === 'sequence') {
    for (const child of node.children) if (await walk(child, context, sh, scope)) return true;
    return false;
  }
  if (node.type === 'parallel') {
    if (active(sh, node, scope)) {
      // Branches are isolated from each other: only the target's own branch can matter.
      const index = node.children.findIndex(child => containsTarget(sh, child));
      const local = { input: context.input, steps: { ...context.steps } };
      return walk(node.children[index], local, sh, extend(scope, `par:${node.relative}[${index}]`));
    }
    const snapshot = { ...context.steps };
    const branches = node.children.map((child, index) => {
      const local = { input: context.input, steps: { ...snapshot } };
      return { local, promise: walk(child, local, sh, extend(scope, `par:${node.relative}[${index}]`)) };
    });
    const results = await Promise.allSettled(branches.map(branch => branch.promise));
    const failed = results.find(result => result.status === 'rejected');
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
    event(sh, 'PARALLEL_JOIN', node, { branches: branches.length });
    return false;
  }
  if (node.type === 'if') {
    const actual = gateValue(renderTemplate(node.config.test, context, `${node.relative}/FLOW.json (test)`), node.config);
    const matches = actual === gateValue(node.config.equals, node.config, true);
    if (!matches && node.config.elseEquals !== undefined && actual !== gateValue(node.config.elseEquals, node.config, true)) {
      throw new AweError('IF_NO_MATCH', `IF ${node.relative} matched neither equals nor elseEquals`);
    }
    const branch = matches ? node.config.then : node.config.else;
    event(sh, 'IF_BRANCH', node, { actual, expected: node.config.equals, branch });
    const chosen = node.children.find(child => child.branch === branch);
    assertAwe(chosen, 'INVALID_FLOW', `Missing branch ${branch} in ${node.relative}`);
    if (active(sh, node, scope) && !containsTarget(sh, chosen)) {
      throw new AweError('TARGET_UNREACHABLE', `Step ${sh.target.display} is in a branch of ${node.relative} that is not selected (the gate chose "${branch}"). It was not executed.`);
    }
    return walk(chosen, context, sh, extend(scope, `if:${node.relative}=${branch}`));
  }
  if (node.type === 'loop') {
    let previous = null;
    for (let i = 1; i <= node.config.maxIterations; i++) {
      event(sh, 'LOOP_ITERATION', node, { iteration: i });
      const frame = new Map();
      // Iteration i is only reached because iteration i-1 did not satisfy the gate, so it
      // depends on everything iteration i-1 produced (even when the values look the same).
      const inner = {
        loops: [...scope.loops, { rel: node.relative, iter: i }],
        control: [...scope.control, `loop:${node.relative}#${i}:${previous ?? '-'}`],
        frames: [...scope.frames, frame],
      };
      for (const child of node.children) if (await walk(child, context, sh, inner)) return true;
      const actual = gateValue(renderTemplate(node.config.until, context, `${node.relative}/FLOW.json (until)`), node.config);
      if (actual === gateValue(node.config.equals, node.config, true)) {
        event(sh, 'LOOP_COMPLETED', node, { iteration: i });
        if (active(sh, node, scope)) {
          throw new AweError('TARGET_UNREACHABLE', `Step ${sh.target.display} is not reached: loop ${node.relative} finished after iteration ${i}. It was not executed.`);
        }
        return false;
      }
      previous = frameDigest(frame);
    }
    throw new AweError('LOOP_EXHAUSTED', `Loop ${node.relative} did not match exit condition after ${node.config.maxIterations} iterations`);
  }
  throw new AweError('INVALID_FLOW', `Unsupported flow type ${node.type}`);
}

// ── Why a step runs again ───────────────────────────────────────────────────
// Ordered by what a person can act on. `prompt` is derived from the others, so it is only named when
// nothing else explains the change.
const REASONS = [
  ['common', 'the common text changed'],
  ['source', 'its prompt file changed'],
  ['executor', 'its command changed'],
  ['outputs', 'its output declarations changed'],
  ['control', 'its place in the workflow changed (IF branch or LOOP pass)'],
  ['upstream', 'an earlier step ran again'],
  ['plan', 'the workflow layout changed'],
  ['address', 'the workflow layout changed'],
  ['v', 'awe was upgraded'],
];

function whyRan(record, now) {
  if (!record.latest) return record.lastFailure ? 'its previous attempt failed' : 'not cached yet';
  const before = record.latest.parts;
  if (!before) return undefined;
  const reasons = [...new Set(REASONS.filter(([key]) => before[key] !== now[key]).map(([, text]) => text))];
  if (!reasons.length && before.prompt !== now.prompt) reasons.push('its rendered prompt changed');
  return reasons.slice(0, 2).join(', ') || undefined;
}

// ── Prompt steps ────────────────────────────────────────────────────────────
function resultEntry(record, loaded, ord) {
  return { output: loaded.output, artifact: loaded.artifact, ...(loaded.files ? { files: loaded.files } : {}), resultId: record.resultId, ord };
}

// Load a cached result only if everything it points at is intact.
async function loadCached(sh, latest) {
  if (!/^[\w-]+$/.test(latest.runId)) return { reason: 'invalid run reference' };
  const runDir = path.join(sh.entry.root, '.awe', 'runs', latest.runId);
  const inside = relative => {
    const resolved = path.resolve(runDir, relative);
    return path.relative(runDir, resolved).startsWith('..') ? null : resolved;
  };
  const artifact = typeof latest.artifact?.path === 'string' ? inside(latest.artifact.path) : null;
  if (!artifact) return { reason: 'invalid artifact reference' };
  let bytes;
  try { bytes = await readFile(artifact); }
  catch { return { reason: 'artifact missing' }; }
  if (bytes.length !== latest.artifact.size || sha256(bytes) !== latest.artifact.sha256) return { reason: 'artifact digest mismatch' };
  let files;
  let details;
  if (latest.files && Object.keys(latest.files).length) {
    files = {};
    details = {};
    for (const [name, file] of Object.entries(latest.files)) {
      const saved = typeof file.path === 'string' ? inside(file.path) : null;
      if (!saved) return { reason: `invalid reference for file ${name}` };
      const problem = await verifyStoredFile(saved, file);
      if (problem) return { reason: `file ${name}: ${problem}` };
      files[name] = saved;
      details[name] = { ...file, path: saved };
    }
  }
  return { output: bytes.toString('utf8'), artifact, files, details };
}

async function walkPrompt(node, context, sh, scope) {
  const { state, session, target } = sh;
  const id = node.id;
  const { ord } = sh.info.get(node);
  const address = addressOf(id, scope.loops);
  const invocation = loopKey(scope.loops);
  const isTarget = Boolean(target) && id === target.stepId && scope.loops.length === target.loops.length
    && scope.loops.every((loop, i) => loop.rel === target.loops[i].rel && loop.iter === target.loops[i].iter);
  const register = resultId => { for (const frame of scope.frames) frame.set(address, resultId); };

  const source = sh.sources.get(node.file);
  let prompt;
  try {
    prompt = buildPrompt(sh.entry, source, context, node);
  } catch (error) {
    // Nothing ran, so the cache is untouched; the step still shows up as failed in this run.
    const failure = { code: error.code ?? 'UNEXPECTED', message: error.message };
    state.invocations.push({ address, step: id, invocation, action: 'EXECUTED', status: 'FAILED', error: failure });
    state.steps[id] = { ...(state.steps[id] ?? { attempts: 0 }), status: 'FAILED', source: node.relative, error: failure };
    event(sh, 'STEP_FAILED', node, { address, code: failure.code, message: failure.message });
    error.step ??= displayAddress(address);
    throw error;
  }
  const decls = sh.outputs.get(id) ?? [];
  // The command line (not its timeout) is part of the identity: another --model is another result.
  const executor = sh.resolveExecutor(id);
  const executorDigest = secretDigest(sh.salt, { argv: executor.argv });
  const upstream = precontext(context, ord);
  const references = [...templateReferences(sh.entry.common ?? ''), ...templateReferences(source)].filter(ref => ref.stepId);
  const inputs = [...new Map(references.map(ref => [ref.expression, { step: ref.stepId, field: ref.fileName ? `files.${ref.fileName}` : ref.field, resultId: context.steps[ref.stepId]?.resultId ?? null }])).values()];
  const parts = {
    v: FINGERPRINT_VERSION, plan: node.relative, address, control: scope.control,
    common: sh.commonDigest, source: sha256(source), input: sh.inputDigest, executor: executorDigest,
    outputs: decls, upstream: upstream.map(([step, result]) => [step, result.resultId]), prompt: sha256(prompt),
  };
  const fingerprint = digestOf(parts);
  // Keyed digests of each part, kept next to the result so a later run can say *what* changed.
  const partDigests = Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, secretDigest(sh.salt, value)]));
  const upstreamDigest = digestOf(upstream.map(([step, result]) => [step, result.resultId]));

  const record = session.ensure(address, id);
  let cacheProblem = null;
  // The target is the thing being tested, so it always runs; everything else is reused when still valid
  // (unless the caller asked for no cache at all).
  if (!isTarget && sh.readCache && record.latest?.fingerprint === fingerprint) {
    const cached = await loadCached(sh, record.latest);
    if (cached.reason) {
      event(sh, 'CACHE_INVALID', node, { address, reason: cached.reason });
      cacheProblem = cached.reason;
      await session.invalidate(address, cached.reason);
    } else {
      context.steps[id] = resultEntry(record.latest, cached, ord);
      register(record.latest.resultId);
      const reused = { runId: record.latest.runId, attempt: record.latest.attempt, resultId: record.latest.resultId, at: record.latest.completedAt };
      const sourcePrompt = typeof record.latest.prompt === 'string' ? path.join(sh.entry.root, '.awe', 'runs', record.latest.runId, record.latest.prompt) : undefined;
      state.invocations.push({ address, step: id, invocation, action: 'REUSED', status: 'COMPLETED', fingerprint, upstreamDigest, inputs, from: reused, resultId: record.latest.resultId, artifact: cached.artifact });
      state.steps[id] = { attempts: state.steps[id]?.attempts ?? 0, status: 'COMPLETED', source: node.relative, reused, ...(record.latest.executor ? { executor: record.latest.executor } : {}), ...(sourcePrompt ? { prompt: sourcePrompt } : {}), artifact: cached.artifact, outputPreview: cached.output.slice(0, 200), ...(cached.details ? { files: cached.details } : {}) };
      state.reused++;
      event(sh, 'STEP_REUSED', node, { address, ...reused });
      return false;
    }
  }

  if (record.unknown && !sh.acknowledged.has(address)) {
    event(sh, 'UNKNOWN_EFFECT', node, { address, ...record.unknown });
    throw new AweError('UNKNOWN_EFFECT', `Step ${displayAddress(address)} has an unknown outcome: its previous attempt (run ${record.unknown.runId}, attempt ${record.unknown.attempt}) ended with ${record.unknown.reason} after the command may have started, and its external effects cannot be known. AWE will not resend it on its own. Check what it may have changed, then run the same command again with --retry ${displayAddress(address)}`);
  }

  const attempt = (state.steps[id]?.attempts ?? 0) + 1;
  const startedAt = new Date().toISOString();
  // Why this step runs although a cache is in use: the one thing a person cannot see from the output.
  const reason = isTarget || !sh.readCache ? undefined : cacheProblem ? `its stored result is unusable: ${cacheProblem}` : whyRan(record, partDigests);
  const entryState = { address, step: id, invocation, attempt, action: 'EXECUTED', status: 'RUNNING', executor: executor.name, ...(reason ? { reason } : {}), fingerprint, upstreamDigest, inputs, startedAt, isTarget };
  state.invocations.push(entryState);
  state.steps[id] = { ...(state.steps[id] ?? {}), attempts: attempt, status: 'RUNNING', source: node.relative, executor: executor.name };
  delete state.steps[id].error;
  delete state.steps[id].stderrTail;
  event(sh, 'STEP_STARTED', node, { address, attempt });
  let phase = 'prepare';
  let began = false;
  let promptFile = null;
  const keepPrompt = sh.entry.config.storePrompts !== false;
  let stderrTail = '';
  try {
    // The rendered prompt is what `awe show <step> --prompt` prints, and what {prompt_file} points at.
    // "storePrompts": false keeps it only for the moment the command needs it.
    if (keepPrompt || needsPromptFile(executor.argv, prompt)) promptFile = await sh.store.prompt(id, attempt, prompt);
    if (keepPrompt) { state.steps[id].prompt = promptFile; entryState.prompt = promptFile; }
    await session.begin(address, id, { runId: state.runId, attempt, fingerprint, startedAt });
    began = true;
    await sh.store.save(state);
    await hook(sh, 'afterIntent', { address });
    const before = decls.length ? await snapshotOutputs(sh.entry.root, decls) : null;
    phase = 'execute';
    const output = await executePrompt(prompt, {
      argv: executor.argv, timeoutMs: executor.timeoutMs, cwd: sh.entry.root, signal: sh.signal,
      promptFile, onStderr: tail => { stderrTail = tail; },
    });
    phase = 'record';
    assertAwe(typeof output === 'string', 'INVALID_RESULT', `Step ${id} produced invalid output`);
    await hook(sh, 'afterExecute', { address });
    const artifact = await sh.store.artifact(id, attempt, output, { exclusive: true });
    await hook(sh, 'afterArtifact', { address });
    const files = !decls.length ? undefined
      : await captureOutputs({ root: sh.entry.root, stepId: id, decls, before, destDir: sh.store.fileDir(id, attempt) });
    await hook(sh, 'afterFiles', { address });

    const resultId = randomUUID();
    const bytes = Buffer.from(output, 'utf8');
    const finishedAt = new Date().toISOString();
    Object.assign(entryState, { status: 'COMPLETED', resultId, finishedAt, artifact, ...(stderrTail ? { stderrTail } : {}) });
    state.steps[id] = { ...state.steps[id], status: 'COMPLETED', attempts: attempt, source: node.relative, artifact, outputPreview: output.slice(0, 200), ...(files ? { files } : {}), ...(stderrTail ? { stderrTail } : {}) };
    delete state.steps[id].reused;
    state.executed++;
    event(sh, 'STEP_COMPLETED', node, { address, attempt, artifact });
    await sh.store.save(state);
    await hook(sh, 'beforeCommit', { address });
    // The commit is the only thing that makes a result reusable, and it is a single atomic file replace.
    await session.commit(address, {
      resultId, runId: state.runId, attempt, fingerprint, parts: partDigests, completedAt: finishedAt, executor: executor.name,
      ...(keepPrompt && promptFile ? { prompt: path.relative(sh.store.dir, promptFile) } : {}),
      artifact: { path: path.relative(sh.store.dir, artifact), sha256: sha256(bytes), size: bytes.length },
      ...(files ? { files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { ...file, path: path.relative(sh.store.dir, file.path) }])) } : {}),
    });
    await hook(sh, 'afterCommit', { address });
    context.steps[id] = { output, artifact, ...(files ? { files: filePaths(files) } : {}), resultId, ord };
    register(resultId);
    if (isTarget) {
      state.stoppedAfter = displayAddress(address);
      event(sh, 'TARGET_DONE', node, { address });
      return true;
    }
    return false;
  } catch (error) {
    const interrupted = error.code === 'RUN_INTERRUPTED';
    // After a kill or timeout the command may have done anything; a plain non-zero exit is a known failure.
    const unknownEffect = phase === 'execute' && (interrupted || error.code === 'EXECUTOR_TIMEOUT' || Boolean(error.signal));
    const tail = error.stderrTail ?? stderrTail;
    if (unknownEffect) {
      entryState.unknownOutcome = true;
      if (error.code === 'EXECUTOR_TIMEOUT') error.message += ` The command may have acted before it was stopped, so run again with --retry ${displayAddress(address)}.`;
    }
    Object.assign(entryState, { status: interrupted ? 'INTERRUPTED' : 'FAILED', finishedAt: new Date().toISOString(), error: { code: error.code ?? 'UNEXPECTED', message: error.message }, ...(tail ? { stderrTail: tail } : {}) });
    state.steps[id] = { ...state.steps[id], status: interrupted ? 'INTERRUPTED' : 'FAILED', error: entryState.error, ...(tail ? { stderrTail: tail } : {}) };
    event(sh, interrupted ? 'STEP_INTERRUPTED' : 'STEP_FAILED', node, { address, attempt, code: error.code ?? 'UNEXPECTED', message: error.message });
    if (began) await session.fail(address, { runId: state.runId, attempt, code: error.code ?? 'UNEXPECTED', message: error.message, unknown: unknownEffect });
    await sh.store.save(state);
    error.step ??= displayAddress(address);
    error.stderrTail ??= tail;
    throw error;
  } finally {
    if (!keepPrompt && promptFile) await rm(promptFile, { force: true });
  }
}
