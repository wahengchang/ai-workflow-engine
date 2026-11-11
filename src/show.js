import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AweError } from './errors.js';
import { displayAddress } from './engine.js';

const RUN_ID = /^[\w-]+$/;

export async function listRuns(root) {
  try {
    return (await readdir(path.join(root, '.awe', 'runs'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadRun(root, runId) {
  if (!RUN_ID.test(runId)) throw new AweError('RUN_NOT_FOUND', `"${runId}" is not a run id. List runs with: awe show`);
  try {
    return JSON.parse(await readFile(path.join(root, '.awe', 'runs', runId, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AweError('RUN_NOT_FOUND', `No run "${runId}" in this workflow. Run something first: awe run`);
    throw new AweError('RUN_NOT_FOUND', `Run ${runId} is unreadable: ${error.message}`);
  }
}

async function runsNewestFirst(root, runId) {
  if (runId) return [await loadRun(root, runId)];
  const states = [];
  for (const id of await listRuns(root)) {
    try { states.push(await loadRun(root, id)); } catch { /* skip unreadable runs */ }
  }
  return states;
}

const clock = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const seconds = (from, to) => {
  const ms = new Date(to) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
};
const indent = (text, spaces) => text.split('\n').map(line => `${' '.repeat(spaces)}${line}`).join('\n');
const firstLine = text => String(text).split('\n', 1)[0];

// One line per step this run touched, in order. Shared by `awe run` and `awe show`.
export function renderSteps(state, root) {
  const rel = file => (file ? path.relative(root, file) : '');
  const lines = [];
  for (const item of state.invocations ?? []) {
    const name = displayAddress(item.address).padEnd(7);
    if (item.action === 'REUSED') {
      lines.push(`  ${name} cached   ${clock(item.from?.at ?? '')}`.trimEnd());
    } else if (item.status === 'COMPLETED') {
      lines.push(`  ${name} ran      ${seconds(item.startedAt, item.finishedAt)}  -> ${rel(item.artifact)}`.trimEnd());
    } else if (item.status === 'RUNNING') {
      lines.push(`  ${name} RUNNING`);
    } else {
      lines.push(`  ${name} ${item.status}  ${firstLine(item.error?.message ?? '')}`.trimEnd());
      if (item.stderrTail) lines.push(indent(item.stderrTail, 10));
    }
  }
  return lines;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export const countsLine = state => `Reused ${plural(state.reused ?? 0, 'step')} · Ran ${plural(state.executed ?? 0, 'step')}`;

export function cacheLine(state) {
  const target = state.target?.address;
  if (state.cache) {
    return target
      ? `on — upstream reused, ${target} always runs (--no-cache reruns everything)`
      : 'on — valid steps are reused (--no-cache reruns everything)';
  }
  return target
    ? `off — everything up to ${target} reruns (--cache reuses valid upstream)`
    : 'off — full run from the first step (--cache reuses valid steps)';
}

export async function show(root, { step, runId, prompt = false, err = false, json = false } = {}) {
  const states = await runsNewestFirst(root, runId);
  if (!states.length) throw new AweError('RUN_NOT_FOUND', 'Nothing has run yet in this workflow.\nNext: awe run 1.1   (or preview the prompts first: awe run --dry)');

  if (step === undefined) {
    const state = states[0];
    if (json) return { output: JSON.stringify(state, null, 2), code: 0 };
    const lines = [
      `Run     ${state.runId}`,
      `Status  ${state.status}${state.error ? ` — ${state.error.code}: ${firstLine(state.error.message)}` : ''}`,
      `Cache   ${cacheLine(state)}`,
      '',
      ...renderSteps(state, root),
      countsLine(state),
    ];
    if (state.error?.stderrTail) lines.push('', `stderr (last lines of ${state.error.step ?? 'the step'}):`, indent(state.error.stderrTail, 2));
    return { output: lines.join('\n'), code: 0 };
  }

  // A step's result may come from an earlier run (a later run reused it), so look back through runs.
  const wantsText = !prompt && !err;
  const holder = states.find(state => {
    const found = state.steps?.[step];
    if (!found) return false;
    return wantsText ? found.status === 'COMPLETED' && found.artifact : true;
  });
  if (!holder) {
    const known = [...new Set(states.flatMap(state => Object.keys(state.steps ?? {})))];
    throw new AweError('STEP_NOT_FOUND', `Step ${step} has no ${wantsText ? 'result' : 'record'} yet${known.length ? ` (steps seen so far: ${known.join(', ')})` : ''}.\nNext: awe run ${step}`);
  }
  const found = holder.steps[step];
  if (json) return { output: JSON.stringify({ run: holder.runId, step, ...found }, null, 2), code: 0 };
  if (prompt) {
    if (!found.prompt) throw new AweError('PROMPT_NOT_STORED', `The prompt of step ${step} was not saved ("storePrompts": false in awe.json). Preview it with: awe run ${step} --dry`);
    return { output: (await readFile(found.prompt, 'utf8')).trimEnd(), code: 0 };
  }
  if (err) return { output: found.stderrTail ?? '', code: 0 };
  return { output: (await readFile(found.artifact, 'utf8')).trimEnd(), code: 0 };
}
