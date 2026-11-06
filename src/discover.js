import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';

// Node names are intentionally numeric and human-readable; IDs are stable within one workflow version.
const numbered = /^(\d+(?:\.\d+)+)[-.](.+)$/;
const stageDir = /^stage-(\d+)(?:[-.].*)?$/;

function position(name) {
  const step = numbered.exec(name);
  if (step) return step[1].split('.').map(Number);
  const stage = stageDir.exec(name);
  if (stage) return [Number(stage[1])];
  return null;
}

function comparePos(a, b) {
  const aa = position(a.name) ?? [];
  const bb = position(b.name) ?? [];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return a.name.localeCompare(b.name);
}

function validConfig(flow, relative) {
  assertAwe(flow && typeof flow === 'object' && !Array.isArray(flow), 'INVALID_FLOW', `${relative}/FLOW.json must be an object`);
  assertAwe(['sequence', 'parallel', 'if', 'loop'].includes(flow.type), 'INVALID_FLOW', `Unknown flow type at ${relative}: ${flow.type}`);
  if (flow.type === 'if') {
    assertAwe(typeof flow.test === 'string' && typeof flow.equals === 'string' && typeof flow.then === 'string' && typeof flow.else === 'string', 'INVALID_FLOW', `IF flow at ${relative} requires test, equals, then and else strings`);
  }
  if (flow.type === 'loop') {
    assertAwe(typeof flow.until === 'string' && typeof flow.equals === 'string' && Number.isInteger(flow.maxIterations) && flow.maxIterations >= 1 && flow.maxIterations <= 100, 'INVALID_FLOW', `LOOP at ${relative} requires until, equals and maxIterations (1–100)`);
  }
}

export async function discoverWorkflow(root) {
  const seen = new Set();
  const rootReal = await realpath(root);
  async function scan(dir, relative, enforceNumbered = true) {
    // Do not follow directory symlinks: a workflow must not escape its root while being discovered.
    const entries = await readdir(dir, { withFileTypes: true });
    const flowEntry = entries.find(e => e.name === 'FLOW.json' && e.isFile());
    let flow = { type: 'sequence' };
    if (flowEntry) {
      try { flow = JSON.parse(await readFile(path.join(dir, 'FLOW.json'), 'utf8')); }
      catch (error) { throw new AweError('INVALID_FLOW', `Invalid FLOW.json at ${relative || '.'}: ${error.message}`); }
      validConfig(flow, relative || '.');
    }
    const children = [];
    let sorted = entries.filter(e => e.isFile() || e.isDirectory()).filter(e => e.name !== 'FLOW.json');
    if (flow.type === 'if') {
      const branches = [flow.then, flow.else];
      assertAwe(branches[0] !== branches[1], 'INVALID_FLOW', `IF branches must be distinct at ${relative}`);
      assertAwe(branches.every(b => /^[a-zA-Z][\w-]*$/.test(b)), 'INVALID_FLOW', 'IF branches must be simple directory names');
      for (const branch of branches) {
        const e = sorted.find(e => e.name === branch && e.isDirectory());
        assertAwe(Boolean(e), 'INVALID_FLOW', `Missing IF branch: ${branch}`);
        const tree = await scan(path.join(dir, branch), path.join(relative, branch), false);
        children.push({ ...tree, branch });
      }
      assertAwe(sorted.every(e => branches.includes(e.name)), 'INVALID_FLOW', `Unexpected files in IF group ${relative}`);
      return { type: 'if', relative, config: flow, children };
    }
    sorted = sorted.filter(e => e.name !== 'ENTRY.md' && e.name !== 'awe.json' && e.name !== '.awe');
    sorted = sorted.filter(e => {
      if (e.name.startsWith('.')) return false;
      if (e.isFile() && !e.name.endsWith('.md')) return false;
      return true;
    });
    for (const entry of sorted.sort(comparePos)) {
      if (entry.isFile()) {
        const match = numbered.exec(entry.name);
        assertAwe(Boolean(match), 'INVALID_STEP', `Prompt must have numeric prefix: ${path.join(relative, entry.name)}`);
        const id = match[1];
        assertAwe(!seen.has(id), 'DUPLICATE_STEP', `Duplicate step number ${id}`);
        seen.add(id);
        children.push({ type: 'prompt', id, relative: path.join(relative, entry.name), file: path.join(dir, entry.name) });
      } else if (entry.isDirectory()) {
        const match = numbered.exec(entry.name);
        const stage = stageDir.exec(entry.name);
        assertAwe(Boolean(match || stage || !enforceNumbered), 'INVALID_STEP', `Directory needs a numeric prefix or stage-N name: ${path.join(relative, entry.name)}`);
        if (match) {
          assertAwe(!seen.has(match[1]), 'DUPLICATE_STEP', `Duplicate step number ${match[1]}`);
          seen.add(match[1]);
        }
        const tree = await scan(path.join(dir, entry.name), path.join(relative, entry.name));
        tree.id = match?.[1];
        children.push(tree);
      }
    }
    return { type: flow.type, relative, config: flow, children };
  }
  const tree = await scan(rootReal, '');
  assertAwe(tree.children.length > 0, 'EMPTY_WORKFLOW', 'No numbered steps found under ENTRY.md');
  return tree;
}

export function flatten(tree) {
  const nodes = [tree];
  for (const child of tree.children ?? []) nodes.push(...flatten(child));
  return nodes;
}
