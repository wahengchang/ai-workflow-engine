import { loadEntry } from './entry.js';
import { discoverWorkflow, flatten, outputLocations } from './discover.js';
import { getPlan, startRun } from './runtime.js';
import { startDev } from './dev.js';
import { readRun } from './storage.js';
import { AweError } from './errors.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateTemplate } from './template.js';
import { getExecutionMode } from './executor.js';
import { initWorkflow } from './init.js';
import { validateReferences } from './preflight.js';

export function parseArgs(argv) {
  if (argv[0] === 'init') {
    const flags = { template: 'content' };
    for (let i = 1; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (!['--template', '--out'].includes(flag)) throw new AweError('CLI_USAGE', `Unknown init option: ${flag}`);
      if (!value || value.startsWith('--')) throw new AweError('CLI_USAGE', `${flag} requires a value`);
      const key = flag.slice(2);
      if (key === 'out' && flags.out !== undefined) throw new AweError('CLI_USAGE', '--out may only be supplied once');
      flags[key] = value;
    }
    if (!flags.out) throw new AweError('CLI_USAGE', 'awe init requires --out <new-directory>');
    return { command: 'init', flags };
  }
  const [command = 'help', target, ...rest] = argv;
  const flags = { input: {}, argv: [], acknowledge: [] };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (['--var', '--executor', '--command', '--arg', '--step', '--invocation', '--acknowledge'].includes(value) && rest[i + 1] === undefined) {
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
    } else if (value === '--invocation') {
      flags.invocation = rest[++i];
    } else if (value === '--acknowledge') {
      flags.acknowledge.push(rest[++i]);
    } else if (value === '--fresh') flags.fresh = true;
    else if (value === '--json') flags.json = true;
    else throw new AweError('CLI_USAGE', `Unknown option: ${value}`);
  }
  if (command !== 'dev') {
    for (const [flag, used] of [['--invocation', flags.invocation !== undefined], ['--fresh', flags.fresh], ['--acknowledge', flags.acknowledge.length > 0]]) {
      if (used) throw new AweError('CLI_USAGE', `${flag} is only supported by awe dev`);
    }
  }
  return { command, target, flags };
}

const HELP = `awe — filesystem-first AI workflow engine (v0.1)\n\nUsage:\n  awe init [--template content] --out <new-directory>\n  awe validate <ENTRY.md|directory>\n  awe plan <ENTRY.md|directory> [--json]\n  awe simulate <ENTRY.md|directory> [--var name=value ...] [--json]\n  awe run <ENTRY.md|directory> [--executor echo|command] [--command executable] [--arg value ...] [--var name=value ...] [--json]\n  awe dev <ENTRY.md|directory> [--step id [--invocation loop=n,...]] [--fresh] [--acknowledge address ...] [executor/--var options as run] [--json]\n  awe status <run-id> [--json]              (run from project root)\n  awe inspect <run-id> [--step 1.2]         (run from project root)\n  awe explain <ENTRY.md|directory> [--step 1.2]\n\nsimulate always uses echo and never starts an external executor.\ndev tests part of a workflow: it reuses valid results from earlier dev commands (never from run), runs missing or stale\nprerequisites, executes --step <id> and stops there; without --step it completes the whole workflow from the cache.\n--fresh starts an empty dev session; --acknowledge <address> allows resending a command whose earlier outcome is unknown.\nSee docs/dev-mode.md.\nrun uses awe.json or CLI executor settings; without either, it defaults to echo.\nSIMULATED artifacts contain rendered prompts, not AI-generated content.\nFor an actual AI CLI use --executor command --command <binary> --arg <argument>.\n`;

function prettyPlan(plan) {
  return plan.map(p => `${p.type.padEnd(9)} ${(p.id || '-').padEnd(8)} ${p.path}`).join('\n');
}

function devSummary(state) {
  const dev = state.dev;
  const scope = dev.scope === 'STEP' ? `step ${dev.target.address}${dev.stoppedAfter ? ' (stopped after the target)' : ''}` : 'full workflow';
  return `Dev: session ${dev.sessionId}${dev.sessionCreated ? ' (new)' : ''}; scope ${scope}\nExecuted: ${dev.executed}, reused: ${dev.reused}`;
}

function executionSummary(state) {
  const mode = state.executionMode ?? getExecutionMode(state.executor);
  const detail = { SIMULATED: 'echo; no AI calls', COMMAND: 'external executor', UNKNOWN: 'executor not recorded' }[mode];
  return `Execution: ${mode}${detail ? ` (${detail})` : ''}`;
}

export async function cli(argv, cwd = process.cwd(), options = {}) {
  const { command, target, flags } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') return { output: HELP, code: 0 };
  if (command === 'init') {
    const destination = path.resolve(cwd, flags.out);
    const entryFile = await initWorkflow(destination, flags.template);
    return { output: `Created ${entryFile}\nExecutor: echo (simulation; no AI calls).\nNext: use awe validate, awe plan, and awe simulate with the ENTRY.md path above.\nConfigure a command executor in awe.json before generating real content.`, code: 0 };
  }
  if (!target) throw new AweError('CLI_USAGE', `Missing argument.\n${HELP}`);
  if (command === 'simulate' && (flags.executor !== undefined || flags.command !== undefined || flags.argv.length)) {
    throw new AweError('CLI_USAGE', 'awe simulate always uses echo; executor options are only supported by awe run');
  }
  if (['status', 'inspect'].includes(command)) {
    const state = await readRun(cwd, target);
    if (command === 'status') {
      return { output: flags.json ? JSON.stringify(state, null, 2) : `${state.runId}: ${state.status}\n${executionSummary(state)}\n${state.mode === 'dev' ? `${devSummary(state)}\n` : ''}Steps: ${Object.keys(state.steps).length}\n${state.error ? `Error: ${state.error.code}: ${state.error.message}` : ''}`, code: 0 };
    }
    const result = flags.step ? state.steps[flags.step] : state;
    if (!result) throw new AweError('STEP_NOT_FOUND', `No step ${flags.step} in run ${target}`);
    return { output: JSON.stringify(result, null, 2), code: 0 };
  }
  if (!['validate', 'plan', 'run', 'simulate', 'explain', 'dev'].includes(command)) throw new AweError('CLI_USAGE', `Unknown command: ${command}\n${HELP}`);
  const entry = await loadEntry(path.resolve(cwd, target));
  const tree = await discoverWorkflow(entry.root, { skip: outputLocations(entry.config) });
  // Check author-written syntax before any executor (and any paid calls) runs.
  validateTemplate(entry.instructions, path.relative(cwd, entry.entryFile) || 'ENTRY.md');
  for (const node of flatten(tree)) {
    if (node.type === 'prompt') validateTemplate(await readFile(node.file, 'utf8'), node.relative);
    if (node.type === 'if') validateTemplate(node.config.test, `${node.relative}/FLOW.json (test)`);
    if (node.type === 'loop') validateTemplate(node.config.until, `${node.relative}/FLOW.json (until)`);
  }
  await validateReferences(entry, tree);
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
  if (command === 'dev') {
    const result = await startDev(entry, tree, {
      executor, input: flags.input, signal: options.signal, step: flags.step, invocation: flags.invocation,
      fresh: flags.fresh, acknowledge: flags.acknowledge, hooks: options.hooks,
    });
    return {
      output: flags.json ? JSON.stringify(result, null, 2) : `Run: ${result.runId}\nStatus: ${result.status}\n${executionSummary(result)}\n${devSummary(result)}\nSteps: ${Object.keys(result.steps).length}${result.error ? `\nError: ${result.error.code}: ${result.error.message}` : ''}\nState: ${path.join(entry.root, '.awe', 'runs', result.runId, 'state.json')}`,
      code: result.status === 'COMPLETED' ? 0 : 1,
    };
  }
  const result = await startRun(entry, tree, { executor, input: flags.input, signal: options.signal });
  return {
    output: flags.json ? JSON.stringify(result, null, 2) : `Run: ${result.runId}\nStatus: ${result.status}\n${executionSummary(result)}\nSteps: ${Object.keys(result.steps).length}${result.error ? `\nError: ${result.error.code}: ${result.error.message}` : ''}\nState: ${path.join(entry.root, '.awe', 'runs', result.runId, 'state.json')}`,
    code: result.status === 'COMPLETED' ? 0 : 1,
  };
}
