import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AweError } from './errors.js';
import { displayAddress, isFormatAddress } from './engine.js';

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
  const width = (state.invocations ?? []).some(item => isFormatAddress(item.address)) ? 8 : 7;
  for (const item of state.invocations ?? []) {
    // A step's formatter is listed right under it: its time, whether it came from the cache, and its own failure.
    const name = (isFormatAddress(item.address) ? `${displayAddress(item.address)} json` : displayAddress(item.address)).padEnd(width);
    if (item.action === 'REUSED') {
      lines.push(`  ${name} cached   ${clock(item.from?.at ?? '')}${item.file ? `  -> ${item.file}` : ''}`.trimEnd());
    } else if (item.status === 'COMPLETED') {
      lines.push(`  ${name} ran      ${seconds(item.startedAt, item.finishedAt)}${item.reason ? `  (${item.reason})` : ''}  -> ${item.file ?? rel(item.artifact)}`.trimEnd());
    } else if (item.status === 'RUNNING') {
      lines.push(`  ${name} RUNNING`);
    } else {
      lines.push(`  ${name} ${item.status}  ${firstLine(item.error?.message ?? '')}`.trimEnd());
      // Most messages fit on the line. Output-checking errors say what to fix on the lines after it.
      // (A command's own failure is not repeated: its stderr is printed below.)
      const more = String(item.error?.message ?? '').split('\n').slice(1);
      if (more.length && !String(item.error?.code ?? '').startsWith('EXECUTOR_')) lines.push(indent(more.join('\n'), 10));
      if (item.rejectedArtifact) lines.push(indent(`The formatter's output is saved in ${rel(item.rejectedArtifact)}`, 10));
      if (item.stderrTail) {
        // The failure message already quotes the start of stderr; do not print that line twice.
        const tail = item.stderrTail.split('\n');
        if (firstLine(item.error?.message ?? '').endsWith(tail[0])) tail.shift();
        if (tail.length) lines.push(indent(tail.join('\n'), 10));
      }
    }
  }
  return lines;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// One vocabulary: when a LOOP made some step run more than once, the counts are runs of a step, not steps.
export function countsLine(state) {
  const items = state.invocations ?? [];
  const steps = items.filter(item => item.kind !== 'format');
  const formats = items.filter(item => item.kind === 'format').length;
  const repeats = steps.length > new Set(steps.map(item => item.step)).size;
  const word = repeats ? 'step run' : 'step';
  const notes = [repeats ? 'a step inside a loop counts once per iteration' : '', formats ? `${plural(formats, 'JSON formatter run')} included` : ''].filter(Boolean);
  return `Reused ${plural(state.reused ?? 0, word)} · Ran ${plural(state.executed ?? 0, word)}${notes.length ? `   (${notes.join('; ')})` : ''}`;
}

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

// A run that reused a step only keeps a pointer to the run that executed it. The prompt, executor and
// stderr live in that run, so follow the pointer.
async function originOf(root, record) {
  if (!record?.reused) return record;
  try {
    const source = await loadRun(root, record.reused.runId);
    const origin = source.steps?.[record.step ?? ''] ?? null;
    return origin ? { ...origin, reused: record.reused, ...(record.format ? { format: record.format } : {}) } : record;
  } catch {
    return record;
  }
}

// A rejected answer is still inspectable output. Prefer that attempt over an older success. (Runs from awe 0.2.x
// builds that checked JSON on the step itself recorded it here; the formatter now records it under .format.)
const outputArtifact = record => record.status === 'COMPLETED' ? record.artifact : record.rejectedArtifact;

const readText = async file => (await readFile(file, 'utf8')).trimEnd();
const section = (title, text) => `── ${title} ──\n${text}`;

// A step that declares "json" has a second record: its formatter. `awe show 1.1` prints the step's own text,
// then what the formatter made of it (or why there is none).
async function formatSection(format) {
  if (!format) return null;
  if (format.status === 'COMPLETED' && format.artifact) return section(format.file ? `json (saved: ${format.file})` : 'json', await readText(format.artifact));
  if (format.rejectedArtifact) return section(`json (rejected: ${firstLine(format.error?.message ?? '')})`, await readText(format.rejectedArtifact));
  return section('json', `(not available: the formatter ${String(format.status ?? 'did not run').toLowerCase()}${format.error ? `, ${firstLine(format.error.message)}` : ''})`);
}

// `awe show 1.1.1@2`: one LOOP occurrence, found among the invocations a run recorded.
async function occurrenceOf(root, states, step, wanted, need) {
  const seen = new Set();
  for (const state of states) {
    for (const item of [...(state.invocations ?? [])].reverse()) {
      if (item.step !== step || item.kind === 'format') continue;
      const shown = displayAddress(item.address);
      seen.add(shown);
      if (shown !== wanted) continue;
      let record = item;
      if (item.action === 'REUSED' && item.from) {
        const source = await loadRun(root, item.from.runId).catch(() => null);
        record = source?.invocations?.find(other => other.address === item.address && other.attempt === item.from.attempt && other.action === 'EXECUTED') ?? item;
      }
      if (need === 'text' ? outputArtifact(record) : need === 'prompt' ? record.prompt : true) {
        // The formatter of the same occurrence, if the step declares JSON.
        const format = [...(state.invocations ?? [])].reverse().find(other => other.kind === 'format' && other.step === step && displayAddress(other.address) === wanted);
        return { runId: state.runId, record, format };
      }
    }
  }
  const known = [...seen].sort();
  throw new AweError('STEP_NOT_FOUND', `No recorded occurrence ${wanted}.${known.length ? ` Occurrences seen: ${known.join(', ')}` : ` Step ${step} has no record yet. Next: awe run ${wanted}`}`);
}

// `awe show 1.1 --raw` / `--formatted`: one part, nothing else, so it can be piped or saved.
async function onlyPart(only, step, raw, format) {
  if (only === 'raw') return { output: raw, code: 0 };
  if (!format) throw new AweError('NO_JSON_OUTPUT', `Step ${step} declares no "json", so it has nothing formatted. \`awe show ${step}\` prints its text.`);
  if (format.status !== 'COMPLETED' || !format.artifact) throw new AweError('NO_JSON_OUTPUT', `The formatter of step ${step} has no result (${String(format.status ?? 'it did not run').toLowerCase()}${format.error ? `: ${firstLine(format.error.message)}` : ''}). \`awe show ${step}\` shows what it returned.`);
  return { output: await readText(format.artifact), code: 0 };
}

export async function show(root, { step, occurrence, runId, prompt = false, err = false, json = false, only } = {}) {
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

  const wantsText = !prompt && !err && !json;
  if (occurrence) {
    const { runId: foundIn, record, format } = await occurrenceOf(root, states, step, occurrence, wantsText ? 'text' : prompt ? 'prompt' : 'any');
    if (json) return { output: JSON.stringify({ run: foundIn, step: occurrence, ...record, ...(format ? { format } : {}) }, null, 2), code: 0 };
    if (prompt) return { output: format?.prompt ? `${section('prompt', await readText(record.prompt))}\n\n${section('json prompt', await readText(format.prompt))}` : await readText(record.prompt), code: 0 };
    if (err) return { output: format?.stderrTail ? `${section('stderr', record.stderrTail ?? '')}\n\n${section('json stderr', format.stderrTail)}` : record.stderrTail ?? '', code: 0 };
    const raw = await readText(outputArtifact(record));
    if (only) return onlyPart(only, occurrence, raw, format);
    const formatted = await formatSection(format);
    return { output: formatted ? `${section('output', raw)}\n\n${formatted}` : raw, code: 0 };
  }

  // A step's result may come from an earlier run (a later run reused it), so look back through runs.
  const holder = states.find(state => {
    const found = state.steps?.[step];
    if (!found) return false;
    return wantsText ? outputArtifact(found) : true;
  });
  if (!holder) {
    const known = [...new Set(states.flatMap(state => Object.keys(state.steps ?? {})))];
    throw new AweError('STEP_NOT_FOUND', `Step ${step} has no ${wantsText ? 'result' : 'record'} yet${known.length ? ` (steps seen so far: ${known.join(', ')})` : ''}.\nNext: awe run ${step}`);
  }
  const found = await originOf(root, { ...holder.steps[step], step });
  if (json) return { output: JSON.stringify({ run: holder.runId, step, ...found }, null, 2), code: 0 };
  if (prompt) {
    if (!found.prompt) throw new AweError('PROMPT_NOT_STORED', `The prompt of step ${step} was not saved ("storePrompts": false in awe.json). Preview it with: awe run ${step} --dry`);
    const gone = file => () => { throw new AweError('PROMPT_NOT_STORED', `The prompt file of step ${step} no longer exists (${file}); it was deleted with an old run. Preview it with: awe run ${step} --dry`); };
    const main = (await readFile(found.prompt, 'utf8').catch(gone(found.prompt))).trimEnd();
    if (!found.format?.prompt) return { output: main, code: 0 };
    return { output: `${section('prompt', main)}\n\n${section('json prompt', (await readFile(found.format.prompt, 'utf8').catch(gone(found.format.prompt))).trimEnd())}`, code: 0 };
  }
  if (err) return { output: found.format?.stderrTail ? `${section('stderr', found.stderrTail ?? '')}\n\n${section('json stderr', found.format.stderrTail)}` : found.stderrTail ?? '', code: 0 };
  const raw = await readText(outputArtifact(found));
  if (only) return onlyPart(only, step, raw, found.format);
  const formatted = await formatSection(found.format);
  return { output: formatted ? `${section('output', raw)}\n\n${formatted}` : raw, code: 0 };
}
