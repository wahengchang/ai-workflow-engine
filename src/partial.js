import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { assertAwe, AweError } from './errors.js';
import { templateReferences } from './template.js';
import { sha256, safeArtifactPath, verifiedArtifactsDir } from './storage.js';

// A partial rerun re-executes only an atomic suffix of a previous run of the same
// workflow. A "unit" is one prompt step, or one whole IF/LOOP/PARALLEL group.
// Sequence groups (stage-* folders, nested numbered sequences) are transparent:
// cuts cross them without entering a control group.

export function canonicalUnits(tree) {
  const units = [];
  function walk(node) {
    if (node.type === 'prompt') { units.push(node); return; }
    if (node.type === 'sequence') { for (const child of node.children) walk(child); return; }
    units.push(node); // if | loop | parallel: atomic, re-executed as a whole
  }
  walk(tree);
  return units;
}

export function flatten(tree) {
  const nodes = [tree];
  for (const child of tree.children ?? []) nodes.push(...flatten(child));
  return nodes;
}

// Resolve --from: a prompt id, or a whole numbered control group's id.
// Control groups are atomic, so a cut may point at one but never enter one.
// Sequence groups stay transparent, but a numbered sequence group is still a
// valid alias: cutting to its id cuts at its first executed unit (equivalent,
// since everything before it is transparent and after it the sequence runs on).
export function resolveCut(tree, from) {
  const units = canonicalUnits(tree);
  const index = units.findIndex(node => node.id === from);
  if (index >= 0) return { units, cutIndex: index, cut: units[index] };
  const group = flatten(tree).find(node => node.id === from && node.type === 'sequence');
  assertAwe(group, 'PARTIAL_INVALID_CUT', `Unknown cut point: ${from}`);
  const aliasIndex = units.findIndex(node => node.relative.startsWith(group.relative + '/') || node.relative.startsWith(group.relative + path.sep));
  assertAwe(aliasIndex >= 0, 'PARTIAL_INVALID_CUT', `Cut point ${from} has no executable steps`);
  return { units, cutIndex: aliasIndex, cut: units[aliasIndex] };
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().map(key => [key, sortedJson(value[key])]);
  }
  return value;
}

// Structural fingerprint: node kinds, ids, paths, branches, child order and full
// FLOW.json configs. Any structure or control change (even downstream) breaks it;
// only downstream prompt file content may change.
export function topologyJson(tree) {
  function walk(node) {
    const out = { type: node.type };
    if (node.id !== undefined) out.id = node.id;
    if (node.relative !== undefined) out.path = node.relative;
    if (node.branch !== undefined) out.branch = node.branch;
    if (node.type !== 'prompt' && node.type !== 'sequence') {
      out.config = node.type === 'parallel' ? { type: 'parallel' } : sortedJson(node.config);
    }
    if (node.children) out.children = node.children.map(walk);
    return out;
  }
  return JSON.stringify(walk(tree));
}

// Hash the workflow itself: topology, ENTRY bytes, resolved input, every prompt
// file and every IF/LOOP FLOW.json. Artifacts (executed outputs) are hashed
// separately by the runtime at save time.
export async function computeFingerprints(entry, tree, input) {
  const prompts = {};
  const flows = {};
  for (const node of flatten(tree)) {
    if (node.type === 'prompt') prompts[node.id] = sha256(await readFile(node.file, 'utf8'));
    if (node.type === 'if' || node.type === 'loop') flows[node.relative] = sha256(JSON.stringify(sortedJson(node.config)));
  }
  return {
    version: 1,
    topology: sha256(topologyJson(tree)),
    entry: sha256(await readFile(entry.entryFile, 'utf8')),
    input: sha256(JSON.stringify(sortedJson(input ?? {}))),
    prompts,
    flows,
  };
}

function nodeName(node) {
  return node.id ?? node.relative ?? '.';
}

function incomplete(node, detail) {
  return new AweError('PARTIAL_SOURCE_INCOMPLETE', `Control group ${node.relative} did not reach terminal completion in the source run: ${detail}`);
}

// Executed, visible upstream step ids for one unit of a terminal source run,
// recursed per control so a PARALLEL or LOOP may contain an IF without ever
// requiring the unchosen branch:
// - IF contributes only its chosen branch, read from the IF_BRANCH event that
//   belongs to the enclosing scope (a LOOP's final iteration when nested);
// - PARALLEL contributes every member executed before its PARALLEL_JOIN;
// - LOOP contributes only the body path of its final completed iteration;
// - a nested LOOP/IF inside a loop body contributes whatever that final
//   iteration's recorded events prove, never a route an earlier iteration took.
// A source run that is itself partial carries no events for the groups the
// parent seeded; those step records were already branch-filtered by the parent,
// so the record-presence fallback below is safe for them.
function executedUpstream(node, source, events = source.events ?? []) {
  const steps = source.steps;
  const promptIds = n => flatten(n).filter(x => x.type === 'prompt').map(x => x.id);
  const completedPrompts = n => promptIds(n).filter(id => steps[id]?.status === 'COMPLETED');
  switch (node.type) {
    case 'prompt': {
      const record = steps[node.id];
      if (record?.status !== 'COMPLETED') {
        throw new AweError('PARTIAL_SOURCE_INCOMPLETE', `Step ${node.id} did not complete in the source run`);
      }
      return [node.id];
    }
    case 'sequence': {
      const out = [];
      for (const child of node.children) out.push(...executedUpstream(child, source, events));
      return out;
    }
    case 'parallel': {
      const joined = events.some(e => e.type === 'PARALLEL_JOIN' && e.node === (node.id ?? node.relative));
      if (!joined) {
        throw incomplete(node, 'parallel branch failed or join never recorded');
      }
      const out = [];
      for (const child of node.children) out.push(...executedUpstream(child, source, events));
      return out;
    }
    case 'if': {
      const branches = node.children;
      const recorded = events.filter(e => e.type === 'IF_BRANCH' && e.node === nodeName(node));
      let chosen;
      if (recorded.length) {
        // The last branch event in this scope is the one this execution took.
        const branch = recorded[recorded.length - 1].branch;
        chosen = branches.find(candidate => candidate.branch === branch);
        if (!chosen) {
          throw incomplete(node, `recorded branch ${branch} no longer exists in the workflow`);
        }
      } else if (source.parentRunId) {
        // A seeded IF in a partial source has no branch event of its own; its
        // parent already filtered the step records to the taken branch.
        const matched = branches.filter(branch => promptIds(branch).some(id => steps[id]));
        if (matched.length !== 1) {
          throw incomplete(node, 'no single branch executed, so no branch context can be reused');
        }
        chosen = matched[0];
      } else {
        throw incomplete(node, 'no branch was recorded for this IF execution');
      }
      // Recursing validates completion per leaf and keeps nested controls on
      // their own recorded path; a flat branch-completion check would wrongly
      // demand prompts from an untaken nested branch.
      return executedUpstream(chosen, source, events);
    }
    case 'loop': {
      const loopEvents = events.filter(e => (e.type === 'LOOP_ITERATION' || e.type === 'LOOP_COMPLETED') && e.node === nodeName(node));
      const completed = loopEvents.filter(e => e.type === 'LOOP_COMPLETED').at(-1);
      if (!completed) {
        if (!loopEvents.length && source.parentRunId) {
          // A seeded loop in a partial source has no loop events of its own;
          // its parent already filtered the step records to the final path.
          return completedPrompts(node);
        }
        throw incomplete(node, 'loop never completed (exhausted, interrupted, or still running)');
      }
      // Scope the body to the final iteration only: an IF inside the body must
      // not contribute the branch a previous iteration happened to take.
      const end = events.lastIndexOf(completed);
      let start = -1;
      for (let i = end - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'LOOP_ITERATION' && e.node === nodeName(node) && e.iteration === completed.iteration) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        throw incomplete(node, `final iteration ${completed.iteration} has no recorded iteration start`);
      }
      const finalIterationEvents = events.slice(start, end);
      const out = [];
      for (const child of node.children) out.push(...executedUpstream(child, source, finalIterationEvents));
      return out;
    }
    default:
      throw new AweError('INVALID_FLOW', `Unsupported unit type ${node.type}`);
  }
}

function sameJson(a, b) {
  return JSON.stringify(sortedJson(a ?? {})) === JSON.stringify(sortedJson(b ?? {}));
}

async function verifySourceArtifact(artifactsDir, source, id, record) {
  const recorded = source.fingerprints.artifacts?.[id];
  assertAwe(recorded, 'PARTIAL_ARTIFACT_MISSING', `Source run does not record a fingerprint for step ${id}`);
  const resolved = await safeArtifactPath(artifactsDir, record?.artifact);
  const info = await lstat(resolved).catch(() => null);
  assertAwe(info && info.isFile() && !info.isSymbolicLink(), 'PARTIAL_ARTIFACT_MISSING', `Artifact for step ${id} is not a normal file in the source run: ${resolved}`);
  const content = await readFile(resolved, 'utf8');
  assertAwe(sha256(content) === recorded, 'PARTIAL_ARTIFACT_CHANGED', `Artifact for step ${id} changed since the source run recorded it`);
  return content;
}

// Declared output files (awe.json steps.<id>.outputs) are part of an executed
// step's result. Reuse must copy them too, and only after proving every source
// copy is still the byte-exact file the source run recorded.
async function verifySourceFiles(artifactsDir, source, id, record) {
  const files = record.files && typeof record.files === 'object' ? Object.entries(record.files) : [];
  if (!files.length) return undefined;
  const recorded = source.fingerprints.files?.[id] ?? {};
  const seeded = {};
  for (const [name, file] of files) {
    if (file.simulated) {
      seeded[name] = { ...file };
      continue;
    }
    const expected = recorded[name];
    assertAwe(expected, 'PARTIAL_ARTIFACT_MISSING', `Source run does not record a fingerprint for output file ${name} of step ${id}`);
    const resolved = await safeArtifactPath(artifactsDir, file.path);
    const info = await lstat(resolved).catch(() => null);
    assertAwe(info && info.isFile() && !info.isSymbolicLink(), 'PARTIAL_ARTIFACT_MISSING', `Output file ${name} of step ${id} is not a normal file in the source run: ${resolved}`);
    const bytes = await readFile(resolved);
    assertAwe(sha256(bytes) === expected, 'PARTIAL_ARTIFACT_CHANGED', `Output file ${name} of step ${id} changed since the source run recorded it`);
    seeded[name] = { ...file, path: resolved };
  }
  return seeded;
}

// Full pre-side-effect verification of a partial rerun. Read-only: no run
// directory is created and no executor starts while this runs.
// Requires that the caller already validated templates and references.
export async function verifyPartial({ entry, tree, from, source, reuseRunId }) {
  // The loaded state must be the run that was requested (state.runId === RUN_ID).
  assertAwe(typeof reuseRunId === 'string' && reuseRunId && source.runId === reuseRunId,
    'PARTIAL_LEGACY_SOURCE', `Requested run ${reuseRunId} does not identify run ${source.runId}`);
  const sourceRoot = entry.root;
  // The source must belong to this workflow (compare resolved realpaths).
  const expected = await realpath(sourceRoot).catch(() => null);
  const sourceWorkflow = await realpath(source.workflow).catch(() => null);
  assertAwe(expected && sourceWorkflow && expected === sourceWorkflow,
    'PARTIAL_WORKFLOW_MISMATCH', `Source run ${source.runId} belongs to ${source.workflow}, not ${sourceRoot}`);

  // The run directory and its artifacts directory must be real entries inside
  // this workflow's .awe/runs tree. A directory moved outside and symlinked
  // back reads like a normal folder through realpath, so containment is proven
  // here, before any state is seeded and before a new run is created.
  // Recorded artifact paths use the workflow path spelling from the source run,
  // which may be another alias of this same directory (for example /tmp vs the
  // canonical /private/tmp). Anchor the prefix check on that recorded spelling,
  // after the realpath equality check above proved both refer to this workflow.
  const recordedRoot = typeof source.workflow === 'string' && source.workflow ? source.workflow : sourceRoot;
  const artifactsDir = await verifiedArtifactsDir(recordedRoot, source.runId);

  // Only fingerprinted runs may seed; legacy runs stay readable but not reusable.
  const fp = source.fingerprints;
  assertAwe(fp?.version === 1 && typeof fp.topology === 'string' && typeof fp.entry === 'string' && typeof fp.input === 'string' && fp.prompts && fp.flows,
    'PARTIAL_LEGACY_SOURCE', `Run ${source.runId} was created without reuse fingerprints and cannot partially rerun`);
  assertAwe(typeof source.runId === 'string' && source.runId, 'PARTIAL_LEGACY_SOURCE', 'Source run lacks a run ID');

  // Terminal only: a source must be completed, failed or interrupted. RUNNING
  // is never silently resumed, and unknown statuses are not accepted either.
  assertAwe(['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(source.status), 'PARTIAL_SOURCE_RUNNING',
    `Run ${source.runId} has non-terminal status ${source.status}; partial reruns accept only COMPLETED, FAILED or INTERRUPTED sources`);
  // FAILED/INTERRUPTED may seed only when every required upstream step
  // completed (enforced per unit below).
  // Partial-of-partial sources must carry complete reuse metadata.
  assertAwe(!source.parentRunId || (typeof source.parentRunId === 'string' && typeof source.from === 'string' && Array.isArray(source.reusedSteps)),
    'PARTIAL_LEGACY_SOURCE', `Run ${source.runId} is a partial run with incomplete reuse metadata`);

  // Input safety: inherited input carries over verbatim, but the separately
  // snapshotted defaults must still match today's awe.json, and a fresh merge
  // of defaults with the recorded --var values must hash identically, so drift
  // cannot hide behind re-hashing the inherited input.
  assertAwe(source.inputSource && typeof source.inputSource.defaults === 'object' && typeof source.inputSource.vars === 'object',
    'PARTIAL_INPUT_CHANGED', `Run ${source.runId} predates input-default snapshots and cannot verify its input`);
  const currentDefaults = entry.config.input ?? {};
  assertAwe(sameJson(source.inputSource.defaults, currentDefaults), 'PARTIAL_INPUT_CHANGED',
    'awe.json input defaults changed since the source run; take a fresh full run before reusing it');
  const carried = { ...currentDefaults, ...source.inputSource.vars };
  assertAwe(sameJson(carried, source.input), 'PARTIAL_INPUT_CHANGED', 'Resolved input (defaults plus source-run --var values) differs from the source run');

  // Resolve the cut. Unknown ids are rejected before any comparison.
  const { units, cutIndex } = resolveCut(tree, from);

  // Structural references and content comparisons.
  const current = await computeFingerprints(entry, tree, carried);
  assertAwe(current.topology === fp.topology, 'PARTIAL_TOPOLOGY_MISMATCH', 'Workflow structure or control config changed since the source run');
  assertAwe(current.entry === fp.entry, 'PARTIAL_ENTRY_CHANGED', 'ENTRY.md changed since the source run');
  assertAwe(current.input === fp.input, 'PARTIAL_INPUT_CHANGED', 'Resolved input differs from the source run');

  // Upstream scope: what the source actually executed before the cut, with
  // IF-branch visibility restricted to the chosen branch. Source steps after
  // the cut are never loaded or seeded.
  const upstreamUnits = units.slice(0, cutIndex);
  const upstreamIds = new Set();
  const ordered = [];
  for (const unit of upstreamUnits) {
    const ids = executedUpstream(unit, source); // may reject incomplete groups
    for (const id of ids) upstreamIds.add(id);
    ordered.push(...ids);
  }

  // Upstream prompt/flow content must be unchanged.
  for (const unit of upstreamUnits) for (const node of flatten(unit)) {
    if (node.type === 'prompt' && upstreamIds.has(node.id)) {
      assertAwe(current.prompts[node.id] === fp.prompts[node.id], 'PARTIAL_UPSTREAM_PROMPT_CHANGED', `Prompt ${node.id} content changed since the source run`);
    }
    if ((node.type === 'if' || node.type === 'loop') && current.flows[node.relative] !== fp.flows[node.relative]) {
      throw new AweError('PARTIAL_UPSTREAM_FLOW_CHANGED', `Control config of ${node.relative} changed since the source run`);
    }
  }

  // Visibility: every upstream step referenced by the executed units — their
  // prompts, their ENTRY instructions, and their control expressions — must be
  // a visible, completed source step. References to other source steps are an
  // incomplete source, not a hidden reuse dump.
  const downstream = units.slice(cutIndex);
  const suffixIds = new Set(flatten({ type: 'sequence', relative: '', children: downstream }).filter(n => n.type === 'prompt').map(n => n.id));

  const entryRefs = templateReferences(entry.instructions, 'ENTRY.md');
  for (const unit of downstream) {
    for (const node of flatten(unit)) {
      if (node.type === 'prompt') {
        for (const ref of [...entryRefs, ...templateReferences(await readFile(node.file, 'utf8'), node.relative)]) {
          requireUpstream(ref.stepId, upstreamIds, suffixIds, source);
        }
      } else if (node.type === 'if') {
        for (const ref of templateReferences(node.config.test, `${node.relative}/FLOW.json (test)`)) requireUpstream(ref.stepId, upstreamIds, suffixIds, source);
      } else if (node.type === 'loop') {
        for (const ref of templateReferences(node.config.until, `${node.relative}/FLOW.json (until)`)) requireUpstream(ref.stepId, upstreamIds, suffixIds, source);
      }
    }
  }

  // Verify each reused artifact is a safe regular file inside the source run,
  // byte-identical to the recorded fingerprint hash.
  const seeds = [];
  for (const id of ordered) {
    const record = source.steps[id];
    const output = await verifySourceArtifact(artifactsDir, source, id, record);
    const files = await verifySourceFiles(artifactsDir, source, id, record);
    seeds.push({ id, attempts: record.attempts, output, source: record.source, ...(files ? { files } : {}) });
  }
  // The runtime executes this synthetic sequence: the cut unit and everything
  // after it, as one ordered atomic-suffix group.
  return {
    parentRunId: source.runId, from, reusedSteps: seeds.map(s => s.id), seeds,
    startNode: { type: 'sequence', relative: '', children: downstream },
  };
}

function requireUpstream(stepId, upstreamIds, suffixIds, source) {
  if (stepId === undefined) return;
  if (upstreamIds.has(stepId)) return;
  if (suffixIds.has(stepId)) return; // executes fresh inside the new suffix
  if (source.steps[stepId]?.status === 'COMPLETED') {
    throw new AweError('PARTIAL_VISIBILITY_CONFLICT', `Step ${stepId} executed in the source run but is not visible from the cut context`);
  }
  throw new AweError('PARTIAL_SOURCE_INCOMPLETE', `Step ${stepId} is referenced downstream but was not completed in the source run`);
}
