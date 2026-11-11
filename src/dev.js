import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AweError, assertAwe } from './errors.js';
import { flatten } from './discover.js';
import { renderTemplate, templateReferences, validateTemplate } from './template.js';
import { executePrompt, getExecutionMode } from './executor.js';
import { RunStore } from './storage.js';
import { buildPrompt, gateValue } from './runtime.js';
import { digestOf, secretDigest, sha256 } from './digest.js';
import { assertOutputLocations, declaredOutputs, snapshotOutputs, captureOutputs, simulatedFiles, filePaths, verifyStoredFile } from './outputs.js';
import { openSession, workspaceSalt } from './dev-store.js';

const FINGERPRINT_VERSION = 1;

// ── Addresses ───────────────────────────────────────────────────────────────
// A step ID names the prompt; an *occurrence* names which pass through enclosing LOOPs
// it belongs to; an *attempt* is one execution of an occurrence. Cache slots are per
// occurrence ("1.2" or "1.2@stage-2/2.1-loop=3"); attempts only ever accumulate.
export const loopKey = loops => loops.map(loop => `${loop.rel.split(path.sep).join('/')}=${loop.iter}`).join(',');
export const addressOf = (stepId, loops) => (loops.length ? `${stepId}@${loopKey(loops)}` : stepId);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = value => value.split(path.sep).join('/');

function parseInvocation(text, loopNodes, stepId) {
  // Workflow-relative addresses are documented with forward slashes on every OS.
  const input = text.replaceAll('\\', '/');
  const pattern = new RegExp(`^${loopNodes.map(loop => `${escapeRegExp(posix(loop.relative))}=(\\d+)`).join(',')}$`);
  const match = pattern.exec(input);
  const format = loopNodes.map(loop => `${posix(loop.relative)}=<1-${loop.config.maxIterations}>`).join(',');
  if (!match) throw new AweError('INVOCATION_INVALID', `Invalid --invocation "${text}" for step ${stepId}. Expected: ${format}`);
  return loopNodes.map((loop, index) => {
    const iter = Number(match[index + 1]);
    assertAwe(iter >= 1 && iter <= loop.config.maxIterations, 'INVOCATION_INVALID', `Iteration ${iter} is outside 1-${loop.config.maxIterations} for loop ${posix(loop.relative)}`);
    return { rel: loop.relative, iter };
  });
}

function knownOccurrences(session, stepId) {
  return session.records()
    .filter(record => record.stepId === stepId && record.address.includes('@') && (record.latest || record.pending || record.unknown || record.lastFailure || record.history.length))
    .map(record => record.address.slice(stepId.length + 1));
}

function resolveInvocation(target, option, session) {
  const { stepId, loopNodes } = target;
  if (!loopNodes.length) {
    assertAwe(option === undefined, 'INVOCATION_INVALID', `Step ${stepId} is not inside a LOOP; --invocation does not apply`);
    return [];
  }
  if (option !== undefined) return parseInvocation(option, loopNodes, stepId);
  const known = knownOccurrences(session, stepId);
  const format = loopNodes.map(loop => `${posix(loop.relative)}=<1-${loop.config.maxIterations}>`).join(',');
  if (known.length > 1) {
    throw new AweError('INVOCATION_REQUIRED', `Step ${stepId} runs inside a LOOP and has several occurrences. Pass --invocation <${format}>. Known occurrences:\n  ${known.sort().join('\n  ')}`);
  }
  // First time (or a single known occurrence): there is nothing to disambiguate.
  if (known.length === 1) return parseInvocation(known[0], loopNodes, stepId);
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
export async function startDev(entry, tree, options = {}) {
  const executor = options.executor ?? entry.config.executor ?? { type: 'echo' };
  assertAwe(['echo', 'command'].includes(executor.type), 'INVALID_EXECUTOR', 'Unknown executor type');
  const outputs = declaredOutputs(entry.config, tree);
  await assertOutputLocations(entry.root, tree, outputs);
  const info = indexTree(tree);

  let targetNode = null;
  if (options.step !== undefined) {
    const prompts = flatten(tree).filter(node => node.type === 'prompt');
    targetNode = prompts.find(node => node.id === options.step);
    if (!targetNode) {
      const shown = prompts.slice(0, 20).map(node => node.id).join(', ');
      throw new AweError('DEV_TARGET_NOT_FOUND', `Step ${options.step} is not a prompt step in this workflow. Available steps: ${shown}${prompts.length > 20 ? ', ...' : ''}`);
    }
  } else {
    assertAwe(options.invocation === undefined, 'CLI_USAGE', '--invocation requires --step');
  }

  const input = { ...(entry.config.input ?? {}), ...(options.input ?? {}) };
  const salt = await workspaceSalt(entry.root);
  const compat = {
    mode: getExecutionMode(executor),
    root: await realpath(entry.root),
    input: secretDigest(salt, input),
    // The whole argv is part of the identity (flags like --model change results) but only a keyed digest is stored.
    executor: secretDigest(salt, { type: executor.type, argv: executor.type === 'command' ? executor.argv : null }),
  };
  const session = await openSession(entry.root, compat, { fresh: options.fresh });
  try {
    return await runInSession(entry, tree, { options, executor, outputs, info, targetNode, input, session });
  } finally {
    await session.release();
  }
}

async function runInSession(entry, tree, { options, executor, outputs, info, targetNode, input, session }) {
  // We hold the session lock, so an intent left behind by a dead process is now known to be orphaned.
  await session.reconcile(entry.root, executor.type);
  const acknowledged = new Set(options.acknowledge ?? []);
  for (const address of acknowledged) {
    assertAwe(session.unknownAddresses().includes(address), 'ACKNOWLEDGE_UNKNOWN',
      `--acknowledge ${address} does not match any invocation with an unknown outcome in session ${session.id}${session.unknownAddresses().length ? `. Unknown: ${session.unknownAddresses().join(', ')}` : ''}`);
  }

  let target = null;
  if (targetNode) {
    const loops = resolveInvocation({ stepId: targetNode.id, loopNodes: info.get(targetNode).loops }, options.invocation, session);
    target = { node: targetNode, stepId: targetNode.id, loops, address: addressOf(targetNode.id, loops) };
  }

  // Every command pins its own view of the sources; edits made while it runs apply to the next command.
  const sources = new Map();
  for (const node of flatten(tree)) {
    if (node.type !== 'prompt') continue;
    const text = await readFile(node.file, 'utf8');
    validateTemplate(text, node.relative);
    sources.set(node.file, text);
  }

  const store = new RunStore(entry.root);
  const state = {
    version: 1, runId: store.runId, workflow: entry.root, mode: 'dev', status: 'RUNNING',
    executionMode: getExecutionMode(executor),
    startedAt: new Date().toISOString(), finishedAt: null,
    executor: { type: executor.type, executable: executor.type === 'command' ? executor.argv?.[0] : undefined },
    input, steps: {}, events: [], error: null,
    dev: {
      sessionId: session.id, sessionCreated: session.created, fresh: Boolean(options.fresh),
      scope: target ? 'STEP' : 'FULL', target: target ? { step: target.stepId, invocation: loopKey(target.loops), address: target.address } : null,
      stoppedAfter: null, executed: 0, reused: 0,
    },
    invocations: [],
  };
  const sh = {
    state, store, session, entry, outputs, info, target, sources,
    signal: options.signal, hooks: options.hooks, acknowledged,
    executor: { ...executor, cwd: entry.root, signal: options.signal },
    entryDigest: sha256(entry.instructions),
    inputDigest: session.data.compat.input,
    executorDigest: session.data.compat.executor,
    subtrees: new Map(),
  };
  await store.initialize(state);
  const context = { input, steps: {} };
  try {
    await walk(tree, context, sh, { loops: [], control: [], frames: [] });
    if (sh.signal?.aborted) throw new AweError('RUN_INTERRUPTED', 'Run interrupted');
    if (target && !state.dev.stoppedAfter) throw new AweError('TARGET_UNREACHABLE', `Step ${target.address} was not reached by this workflow`);
    state.status = 'COMPLETED';
  } catch (error) {
    state.status = error.code === 'RUN_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED';
    state.error = { code: error.code ?? 'UNEXPECTED', message: error.message };
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
      throw new AweError('TARGET_UNREACHABLE', `Step ${sh.target.address} is in a branch of ${node.relative} that is not selected (the gate chose "${branch}"). It was not executed.`);
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
          throw new AweError('TARGET_UNREACHABLE', `Step ${sh.target.address} is not reached: loop ${node.relative} finished after iteration ${i}. It was not executed.`);
        }
        return false;
      }
      previous = frameDigest(frame);
    }
    throw new AweError('LOOP_EXHAUSTED', `Loop ${node.relative} did not match exit condition after ${node.config.maxIterations} iterations`);
  }
  throw new AweError('INVALID_FLOW', `Unsupported flow type ${node.type}`);
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
      if (file.simulated) { files[name] = file.path; details[name] = file; continue; }
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
    throw error;
  }
  const decls = sh.outputs.get(id) ?? [];
  const upstream = precontext(context, ord);
  const references = [...templateReferences(sh.entry.instructions), ...templateReferences(source)].filter(ref => ref.stepId);
  const inputs = [...new Map(references.map(ref => [ref.expression, { step: ref.stepId, field: ref.fileName ? `files.${ref.fileName}` : ref.field, resultId: context.steps[ref.stepId]?.resultId ?? null }])).values()];
  const fingerprint = digestOf({
    v: FINGERPRINT_VERSION, plan: node.relative, address, control: scope.control,
    entry: sh.entryDigest, source: sha256(source), input: sh.inputDigest, executor: sh.executorDigest,
    outputs: decls, upstream: upstream.map(([step, result]) => [step, result.resultId]), prompt: sha256(prompt),
  });
  const upstreamDigest = digestOf(upstream.map(([step, result]) => [step, result.resultId]));

  const record = session.ensure(address, id);
  // The target is the thing being tested, so it always runs; everything else is reused when still valid.
  if (!isTarget && record.latest?.fingerprint === fingerprint) {
    const cached = await loadCached(sh, record.latest);
    if (cached.reason) {
      event(sh, 'CACHE_INVALID', node, { address, reason: cached.reason });
      await session.invalidate(address, cached.reason);
    } else {
      context.steps[id] = resultEntry(record.latest, cached, ord);
      register(record.latest.resultId);
      const reused = { runId: record.latest.runId, attempt: record.latest.attempt, resultId: record.latest.resultId };
      state.invocations.push({ address, step: id, invocation, action: 'REUSED', status: 'COMPLETED', fingerprint, upstreamDigest, inputs, from: reused, resultId: record.latest.resultId, artifact: cached.artifact });
      state.steps[id] = { attempts: state.steps[id]?.attempts ?? 0, status: 'COMPLETED', source: node.relative, reused, artifact: cached.artifact, outputPreview: cached.output.slice(0, 200), ...(cached.details ? { files: cached.details } : {}) };
      state.dev.reused++;
      event(sh, 'STEP_REUSED', node, { address, ...reused });
      return false;
    }
  }

  if (sh.executor.type === 'command' && record.unknown && !sh.acknowledged.has(address)) {
    event(sh, 'UNKNOWN_EFFECT', node, { address, ...record.unknown });
    throw new AweError('UNKNOWN_EFFECT', `Step ${address} has an unknown outcome: its previous attempt (run ${record.unknown.runId}, attempt ${record.unknown.attempt}) ended with ${record.unknown.reason} after the command may have started, and its external effects cannot be known. AWE will not resend it on its own. Check what it may have changed, then rerun with --acknowledge ${address}`);
  }

  const attempt = (state.steps[id]?.attempts ?? 0) + 1;
  const startedAt = new Date().toISOString();
  const entryState = { address, step: id, invocation, attempt, action: 'EXECUTED', status: 'RUNNING', fingerprint, upstreamDigest, inputs, startedAt, isTarget };
  state.invocations.push(entryState);
  state.steps[id] = { ...(state.steps[id] ?? {}), attempts: attempt, status: 'RUNNING', source: node.relative };
  event(sh, 'STEP_STARTED', node, { address, attempt });
  if (sh.entry.config.storePrompts === true) state.steps[id].prompt = await sh.store.prompt(id, attempt, prompt);
  let phase = 'prepare';
  let began = false;
  try {
    await session.begin(address, id, { runId: state.runId, attempt, fingerprint, startedAt });
    began = true;
    await sh.store.save(state);
    await hook(sh, 'afterIntent', { address });
    const simulated = sh.executor.type === 'echo';
    const before = decls.length && !simulated ? await snapshotOutputs(sh.entry.root, decls) : null;
    phase = 'execute';
    const output = await executePrompt(prompt, sh.executor);
    phase = 'record';
    assertAwe(typeof output === 'string', 'INVALID_RESULT', `Step ${id} produced invalid output`);
    await hook(sh, 'afterExecute', { address });
    const artifact = await sh.store.artifact(id, attempt, output, { exclusive: true });
    await hook(sh, 'afterArtifact', { address });
    const files = !decls.length ? undefined : simulated ? simulatedFiles(decls)
      : await captureOutputs({ root: sh.entry.root, stepId: id, decls, before, destDir: sh.store.fileDir(id, attempt) });
    await hook(sh, 'afterFiles', { address });

    const resultId = randomUUID();
    const bytes = Buffer.from(output, 'utf8');
    const finishedAt = new Date().toISOString();
    Object.assign(entryState, { status: 'COMPLETED', resultId, finishedAt, artifact });
    state.steps[id] = { ...state.steps[id], status: 'COMPLETED', attempts: attempt, source: node.relative, artifact, outputPreview: output.slice(0, 200), ...(files ? { files } : {}) };
    delete state.steps[id].reused;
    state.dev.executed++;
    event(sh, 'STEP_COMPLETED', node, { address, attempt, artifact });
    await sh.store.save(state);
    await hook(sh, 'beforeCommit', { address });
    // The commit is the only thing that makes a result reusable, and it is a single atomic file replace.
    await session.commit(address, {
      resultId, runId: state.runId, attempt, fingerprint, completedAt: finishedAt,
      artifact: { path: path.relative(sh.store.dir, artifact), sha256: sha256(bytes), size: bytes.length },
      ...(files ? { files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { ...file, path: file.simulated ? file.path : path.relative(sh.store.dir, file.path) }])) } : {}),
    });
    await hook(sh, 'afterCommit', { address });
    context.steps[id] = { output, artifact, ...(files ? { files: filePaths(files) } : {}), resultId, ord };
    register(resultId);
    if (isTarget) {
      state.dev.stoppedAfter = address;
      event(sh, 'DEV_STOPPED', node, { address });
      return true;
    }
    return false;
  } catch (error) {
    const interrupted = error.code === 'RUN_INTERRUPTED';
    // After a kill or timeout the command may have done anything; a plain non-zero exit is a known failure.
    const unknownEffect = sh.executor.type === 'command' && phase === 'execute' && (interrupted || error.code === 'EXECUTOR_TIMEOUT' || Boolean(error.signal));
    Object.assign(entryState, { status: interrupted ? 'INTERRUPTED' : 'FAILED', finishedAt: new Date().toISOString(), error: { code: error.code ?? 'UNEXPECTED', message: error.message } });
    state.steps[id] = { ...state.steps[id], status: interrupted ? 'INTERRUPTED' : 'FAILED', error: entryState.error };
    event(sh, interrupted ? 'STEP_INTERRUPTED' : 'STEP_FAILED', node, { address, attempt, code: error.code ?? 'UNEXPECTED', message: error.message });
    if (began) await session.fail(address, { runId: state.runId, attempt, code: error.code ?? 'UNEXPECTED', message: error.message, unknown: unknownEffect });
    await sh.store.save(state);
    throw error;
  }
}
