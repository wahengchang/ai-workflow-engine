import { loadEntry } from './entry.js';
import { discoverWorkflow, flatten } from './discover.js';
import { getPlan, startRun } from './runtime.js';
import { readRun } from './storage.js';
import { AweError } from './errors.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateTemplate } from './template.js';
import { getExecutionMode } from './executor.js';
import { compileOutputs, getOutputs } from './outputs.js';

export function parseArgs(argv) {
  const [command = 'help', target, ...rest] = argv;
  const flags = { input: {}, argv: [] };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (['--var', '--executor', '--command', '--arg', '--step', '--workflow'].includes(value) && rest[i + 1] === undefined) {
      throw new AweError('CLI_USAGE', `${value} requires a value`);
    }
    if (value === '--var') {
      const pair = rest[++i] ?? '';
      const match = /^([A-Za-z_][\w-]*)=([\s\S]*)$/.exec(pair);
      if (!match) throw new AweError('CLI_USAGE', '--var requires key=value');
      flags.input[match[1]] = match[2];
    } else if (value === '--executor') {
      flags.executor = rest[++i];
    } else if (value === '--command') {
      flags.command = rest[++i];
      if (!flags.command) throw new AweError('CLI_USAGE', '--command requires a non-empty executable');
    } else if (value === '--arg') {
      flags.argv.push(rest[++i]);
    } else if (value === '--step') {
      flags.step = rest[++i];
    } else if (value === '--workflow') {
      flags.workflow = rest[++i];
      if (!flags.workflow) throw new AweError('CLI_USAGE', '--workflow requires a workflow directory');
    } else if (value === '--json') flags.json = true;
    else throw new AweError('CLI_USAGE', `Unknown option: ${value}`);
  }
  return { command, target, flags };
}

const HELP = `awe — filesystem-first AI workflow engine (v0.1)\n\nUsage:\n  awe validate <ENTRY.md|directory>\n  awe plan <ENTRY.md|directory> [--json]\n  awe simulate <ENTRY.md|directory> [--var name=value ...] [--json]\n  awe run <ENTRY.md|directory> [--executor echo|command] [--command executable] [--arg value ...] [--var name=value ...] [--json]\n  awe outputs <run-id> [--json] [--workflow directory]\n  awe status <run-id> [--json] [--workflow directory]\n  awe inspect <run-id> [--step 1.2] [--workflow directory]\n  awe explain <ENTRY.md|directory> [--step 1.2]\n\nsimulate always uses echo and never starts an external executor.\nrun uses awe.json or CLI executor settings; without either, it defaults to echo.\nSIMULATED artifacts contain rendered prompts, not AI-generated content.\nFor an actual AI CLI use --executor command --command <binary> --arg <argument>.\n`;

function prettyPlan(plan) {
  return plan.map(p => `${p.type.padEnd(9)} ${(p.id || '-').padEnd(8)} ${p.path}`).join('\n');
}

function executionSummary(state) {
  const mode = state.executionMode ?? getExecutionMode(state.executor);
  const detail = { SIMULATED: 'echo; no AI calls', COMMAND: 'external executor', UNKNOWN: 'executor not recorded' }[mode];
  return `Execution: ${mode}${detail ? ` (${detail})` : ''}`;
}

function namedOutputLines(outputs) {
  return Object.entries(outputs).map(([name, value]) => `Output ${name} (step ${value.stepId}, attempt ${value.attempt}): ${value.artifact}`);
}

function prettyOutputs(state) {
  const report = getOutputs(state);
  return [
    `Run: ${state.runId}`, `Status: ${state.status}`, executionSummary(state),
    ...(state.error ? [`Error: ${state.error.code}: ${state.error.message}`] : []),
    ...(report.complete ? [] : ['Partial results only; this run has not completed successfully.']),
    ...(Object.keys(report.outputs).length ? namedOutputLines(report.outputs) : [Object.keys(report.outputDefinitions).length
      ? 'Named outputs: unavailable (run has not completed successfully).'
      : 'Named outputs: none declared (configure outputs in awe.json for new runs).']),
    'Latest completed step artifacts:',
    ...(report.artifacts.length ? report.artifacts.map(value => `  ${value.stepId} (attempt ${value.attempt}): ${value.artifact}`) : ['  none']),
  ].join('\n');
}

export async function cli(argv, cwd = process.cwd(), options = {}) {
  const { command, target, flags } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') return { output: HELP, code: 0 };
  if (!target) throw new AweError('CLI_USAGE', `Missing argument.\n${HELP}`);
  if (command === 'outputs' && (flags.step !== undefined || flags.executor !== undefined || flags.command !== undefined || flags.argv.length || Object.keys(flags.input).length)) {
    throw new AweError('CLI_USAGE', 'awe outputs accepts only --json and --workflow');
  }
  if (command === 'simulate' && (flags.executor !== undefined || flags.command !== undefined || flags.argv.length)) {
    throw new AweError('CLI_USAGE', 'awe simulate always uses echo; executor options are only supported by awe run');
  }
  if (flags.workflow !== undefined && !['status', 'inspect', 'outputs'].includes(command)) throw new AweError('CLI_USAGE', '--workflow is only supported by status, inspect, and outputs');
  if (['status', 'inspect', 'outputs'].includes(command)) {
    const state = await readRun(flags.workflow === undefined ? cwd : path.resolve(cwd, flags.workflow), target);
    if (command === 'outputs') return { output: flags.json ? JSON.stringify(getOutputs(state), null, 2) : prettyOutputs(state), code: 0 };
    if (command === 'status') {
      return { output: flags.json ? JSON.stringify(state, null, 2) : `${state.runId}: ${state.status}\n${executionSummary(state)}\nSteps: ${Object.keys(state.steps).length}\n${state.error ? `Error: ${state.error.code}: ${state.error.message}` : ''}`, code: 0 };
    }
    const result = flags.step ? state.steps[flags.step] : state;
    if (!result) throw new AweError('STEP_NOT_FOUND', `No step ${flags.step} in run ${target}`);
    return { output: JSON.stringify(result, null, 2), code: 0 };
  }
  if (!['validate', 'plan', 'run', 'simulate', 'explain'].includes(command)) throw new AweError('CLI_USAGE', `Unknown command: ${command}\n${HELP}`);
  const entry = await loadEntry(path.resolve(cwd, target));
  const tree = await discoverWorkflow(entry.root);
  compileOutputs(entry.config.outputs, tree);
  // Check author-written syntax before any executor (and any paid calls) runs.
  validateTemplate(entry.instructions, path.relative(cwd, entry.entryFile) || 'ENTRY.md');
  for (const node of flatten(tree)) {
    if (node.type === 'prompt') validateTemplate(await readFile(node.file, 'utf8'), node.relative);
    if (node.type === 'if') validateTemplate(node.config.test, `${node.relative}/FLOW.json (test)`);
    if (node.type === 'loop') validateTemplate(node.config.until, `${node.relative}/FLOW.json (until)`);
  }
  const plan = getPlan(tree);
  if (command === 'validate') return { output: `VALID ${entry.entryFile} (${plan.filter(p => p.type === 'prompt').length} prompt steps)`, code: 0 };
  if (command === 'plan') return { output: flags.json ? JSON.stringify(plan, null, 2) : prettyPlan(plan), code: 0 };
  if (command === 'explain') {
    const matching = flags.step ? flatten(tree).filter(x => x.id === flags.step) : [tree];
    if (matching.length !== 1) throw new AweError('STEP_NOT_FOUND', `Step not found: ${flags.step}`);
    return { output: JSON.stringify({ entry: entry.entryFile, config: entry.config, node: matching[0].type === 'prompt' ? { ...matching[0], file: undefined } : { type: matching[0].type, relative: matching[0].relative, config: matching[0].config }, instructionSource: entry.entryFile }, null, 2), code: 0 };
  }
  const defaults = entry.config.executor ?? {};
  if (flags.command && flags.executor && flags.executor !== 'command') throw new AweError('CLI_USAGE', '--command conflicts with a non-command executor');
  if (flags.argv.length && !flags.command) throw new AweError('CLI_USAGE', '--arg requires --command');
  const executor = command === 'simulate' ? { type: 'echo' } : {
    type: flags.executor ?? (flags.command ? 'command' : defaults.type ?? 'echo'),
    argv: flags.command ? [flags.command, ...flags.argv] : defaults.argv,
    timeoutMs: defaults.timeoutMs ?? 120000,
  };
  if (executor.type === 'command' && (!executor.argv || !executor.argv.length)) throw new AweError('CLI_USAGE', 'Command executor requires --command <executable> or awe.json executor.argv');
  const result = await startRun(entry, tree, { executor, input: flags.input, signal: options.signal });
  return {
    output: flags.json ? JSON.stringify(result, null, 2) : [
      `Run: ${result.runId}`, `Status: ${result.status}`, executionSummary(result), `Steps: ${Object.keys(result.steps).length}`,
      ...(result.error ? [`Error: ${result.error.code}: ${result.error.message}`] : []),
      ...namedOutputLines(result.outputs),
      `State: ${path.join(entry.root, '.awe', 'runs', result.runId, 'state.json')}`,
    ].join('\n'),
    code: result.status === 'COMPLETED' ? 0 : 1,
  };
}
