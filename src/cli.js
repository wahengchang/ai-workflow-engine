import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadEntry, findWorkflowRoot } from './entry.js';
import { discoverWorkflow, flatten, outputLocations } from './discover.js';
import { getPlan } from './runtime.js';
import { runWorkflow, parseStepArg, displayAddress } from './engine.js';
import { dryRun } from './dry.js';
import { AweError } from './errors.js';
import { validateTemplate } from './template.js';
import { initWorkflow } from './init.js';
import { validateReferences } from './preflight.js';
import { resolveExecutor, noExecutorError } from './config.js';
import { show, renderSteps, countsLine, cacheLine } from './show.js';
import { findExecutable, detectAgent } from './which.js';

// ── Help ────────────────────────────────────────────────────────────────────
const HELP = `awe — filesystem-first AI workflow engine

Usage:
  awe init <dir>                  create a workflow (detects an AI CLI on your PATH)
  awe run  [dir] [step] [flags]   run the workflow, or just one step of it
  awe show [dir] [step] [flags]   look at results (output, prompt, stderr)
  awe check [dir]                 validate, list the steps, check the executor

  dir   a workflow folder; default: the current folder, or the nearest parent holding ENTRY.md
  step  1.2, 3.1.2, or 2.1.1@2 (iteration 2 of the LOOP around 2.1.1)

Build a workflow one step at a time:
  awe run 1.1        run step 1.1
  awe run 1.2        1.1 comes from the cache, only 1.2 runs
  awe run            the whole workflow, from the start

Flags for run:
  --var key=value     override an input (repeatable)
  --cache / --no-cache  reuse valid results / rerun everything.
                      Default: cache on when you name a step, off for a whole run
  --dry               print the rendered prompts; call nothing, write nothing
  --executor <name>   use a named executor from awe.json "executors"
  --timeout <sec>     time limit for each step (default: awe.json "timeout", else 300)
  --retry <step>      run again a step whose outcome is unknown after a crash or timeout
  --json              machine-readable output

Configure the AI command in awe.json:  "run": "claude -p {prompt}"
  {prompt} the rendered prompt (very long prompts become a file path automatically)
  {prompt_file} the path of the saved prompt file    (no placeholder: sent on stdin)

Exit codes: 0 ok · 1 a step failed · 2 usage or configuration problem · 129/130/143 interrupted (SIGHUP/SIGINT/SIGTERM)
Docs: docs/cli.md
`;

const COMMAND_HELP = {
  init: 'Usage: awe init <dir>\nCreates a six-step content workflow in a new folder and writes the first AI CLI found on PATH (claude, codex, opencode, omp) into awe.json as "run". Refuses existing folders.',
  run: `Usage: awe run [dir] [step] [flags]\n\n${HELP.slice(HELP.indexOf('Build a workflow'), HELP.indexOf('Exit codes')).trim()}`,
  show: 'Usage: awe show [dir] [step] [--prompt] [--err] [--run <id>] [--json]\n  awe show              summary of the latest run\n  awe show 1.2          the output text of step 1.2\n  awe show 1.2 --prompt the rendered prompt that was sent\n  awe show 1.2 --err    the last lines the command wrote to stderr',
  check: 'Usage: awe check [dir] [--json]\nValidates the workflow, lists its steps and checks that each executor command exists on PATH.',
};

const REMOVED = {
  simulate: 'awe simulate was replaced by: awe run --dry   (prints the rendered prompts; calls nothing)',
  dev: 'awe dev was replaced by: awe run <step>   (the named step always runs; steps before it come from the cache)',
  validate: 'awe validate was replaced by: awe check',
  plan: 'awe plan was replaced by: awe check',
  explain: 'awe explain was replaced by: awe show <step> --prompt   (or awe check for the plan)',
  status: 'awe status was replaced by: awe show',
  inspect: 'awe inspect was replaced by: awe show <step>',
};

// ── Argument parsing ────────────────────────────────────────────────────────
const FLAGS = {
  init: {},
  run: { '--var': 'multi', '--cache': 'bool', '--no-cache': 'bool', '--dry': 'bool', '--executor': 'value', '--timeout': 'value', '--retry': 'multi', '--json': 'bool' },
  show: { '--prompt': 'bool', '--err': 'bool', '--run': 'value', '--json': 'bool' },
  check: { '--json': 'bool' },
};
// Anything that starts like a step address is treated as one, so a typo such as 2.1@x gets a step-address error.
const STEP_ARG = /^\d+(?:\.\d+)+(?:@|$)/;

function usage(message, extra = {}) {
  return Object.assign(new AweError('CLI_USAGE', message), extra);
}

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) return { command: 'help', flags: {}, topic: rest[0] };
  if (REMOVED[command]) throw usage(REMOVED[command]);
  if (!FLAGS[command]) throw usage(`Unknown command "${command}". Commands: init, run, show, check   (see: awe --help)`);
  const spec = FLAGS[command];
  const flags = { input: {}, retry: [] };
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    let token = rest[i];
    if (token === '--help' || token === '-h') return { command: 'help', flags: {}, topic: command };
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    let inline;
    const equals = token.indexOf('=');
    if (equals > 0) { inline = token.slice(equals + 1); token = token.slice(0, equals); }
    const kind = spec[token];
    if (!kind) {
      throw usage(`Unknown flag ${token} for awe ${command}.${Object.keys(spec).length ? ` Flags: ${Object.keys(spec).join(' ')}` : ' It takes no flags.'}`);
    }
    if (kind === 'bool') {
      if (inline !== undefined) throw usage(`${token} does not take a value`);
      flags[token.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    // A flag that needs a value never swallows the next flag.
    const value = inline ?? rest[++i];
    if (value === undefined || (inline === undefined && value.startsWith('-'))) {
      throw usage(`${token} needs a value${VALUE_HINT[token] ? `: ${VALUE_HINT[token]}` : ''}`, { hint: token });
    }
    if (token === '--var') {
      const match = /^([A-Za-z_][\w-]*)=([\s\S]*)$/.exec(value);
      if (!match) throw usage('--var needs key=value, e.g. --var topic="How to choose coffee beans"');
      flags.input[match[1]] = match[2];
    } else if (token === '--timeout') {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw usage(`--timeout needs a positive number of seconds, got "${value}". Example: --timeout 600`);
      flags.timeout = seconds;
    } else if (token === '--retry') {
      parseStepArg(value);
      flags.retry.push(value);
    } else if (token === '--executor') flags.executor = value;
    else if (token === '--run') flags.runId = value;
  }
  if (flags.cache && flags.noCache) throw usage('--cache and --no-cache are the two states of one switch; pass only one');

  let dir;
  let step;
  for (const item of positionals) {
    if (command !== 'init' && command !== 'check' && STEP_ARG.test(item)) {
      parseStepArg(item);
      if (step !== undefined) throw usage(`Only one step can be named, got "${step}" and "${item}"`);
      step = item;
    } else {
      if (dir !== undefined) throw usage(`Only one workflow folder can be named, got "${dir}" and "${item}"`);
      dir = item;
    }
  }
  if (command === 'init' && !dir) throw usage('awe init needs a new folder name, e.g. awe init coffee');
  if (command === 'run' && flags.dry) {
    for (const [flag, used] of [['--cache', flags.cache], ['--no-cache', flags.noCache], ['--executor', flags.executor !== undefined], ['--timeout', flags.timeout !== undefined], ['--retry', flags.retry.length > 0]]) {
      if (used) throw usage(`--dry calls nothing, so ${flag} has no effect. Drop one of them`);
    }
  }
  if (command === 'show' && flags.prompt && flags.err) throw usage('--prompt and --err show different things; pass only one');
  if (command === 'show' && (flags.prompt || flags.err) && !step) throw usage(`${flags.prompt ? '--prompt' : '--err'} needs a step, e.g. awe show 1.2 ${flags.prompt ? '--prompt' : '--err'}`);
  return { command, dir, step, flags };
}

const VALUE_HINT = {
  '--executor': 'the name of an executor from awe.json "executors"   e.g. awe run 1.1 --executor search',
  '--timeout': 'seconds   e.g. --timeout 600',
  '--var': 'key=value   e.g. --var topic="How to choose coffee beans"',
  '--retry': 'a step address   e.g. --retry 1.2',
  '--run': 'a run id (the folder name under .awe/runs)',
};

// ── Shared steps ────────────────────────────────────────────────────────────
// Everything that can be checked without calling an executor.
async function prepare(cwd, dir) {
  const found = await findWorkflowRoot(path.resolve(cwd, dir ?? '.'));
  const entry = await loadEntry(found);
  const tree = await discoverWorkflow(entry.root, { outputs: outputLocations(entry.config) });
  // Check author-written syntax before any executor (and any paid calls) runs.
  validateTemplate(entry.instructions, path.relative(cwd, entry.entryFile) || 'ENTRY.md');
  const sources = new Map();
  for (const node of flatten(tree)) {
    if (node.type === 'prompt') {
      const text = await readFile(node.file, 'utf8');
      validateTemplate(text, node.relative);
      sources.set(node.file, text);
    }
    if (node.type === 'if') validateTemplate(node.config.test, `${node.relative}/FLOW.json (test)`);
    if (node.type === 'loop') validateTemplate(node.config.until, `${node.relative}/FLOW.json (until)`);
  }
  const outputs = await validateReferences(entry, tree, sources);
  const promptIds = flatten(tree).filter(node => node.type === 'prompt').map(node => node.id);
  const warnings = [...entry.settings.warnings, ...(tree.ignoredEntries ?? []).map(file => `${file} is ignored: only the ENTRY.md at the workflow root is used, and it is added to every step. Move its text into the root ENTRY.md or into that folder's step prompts. (Running awe from inside ${path.dirname(file)} would treat that folder as a separate workflow.)`)];
  return { entry, tree, promptIds, sources, outputs, warnings };
}

function prettyPlan(plan) {
  return plan.map(p => `  ${p.type.padEnd(9)} ${(p.id || '-').padEnd(8)} ${p.path}`).join('\n');
}

function describeExecutors(settings, promptIds, overrides, root) {
  const seen = new Map();
  for (const id of promptIds) {
    const executor = resolveExecutor(settings, id, overrides, root);
    seen.set(executor.name, executor.display);
  }
  return seen.size === 1 ? [...seen.values()][0] : [...seen].map(([name, display]) => `${name}=${display}`).join(' · ');
}

// ── Commands ────────────────────────────────────────────────────────────────
async function initCommand({ dir }, cwd, options = {}) {
  const destination = path.resolve(cwd, dir);
  const agent = await detectAgent({ env: options.env ?? process.env });
  const entryFile = await initWorkflow(destination, { agent });
  const shown = path.relative(cwd, path.dirname(entryFile)) || '.';
  const into = shown.includes(' ') ? JSON.stringify(shown) : shown;
  const lines = [`Created ${shown}/  (6 steps: research, outline, draft, two parallel checks, deliver)`];
  lines.push(agent
    ? `Executor  ${agent.run}   (found ${agent.name} on PATH; change "run" in awe.json to use another)`
    : 'Executor  none found on PATH. Add one to awe.json, e.g.  "run": "claude -p {prompt}"');
  lines.push('ENTRY.md  instructions added to the prompt of every step; keep it short', '', `Next  cd ${into}`, '      awe run --dry     preview every prompt; calls nothing');
  lines.push(agent ? '      awe run 1.1       run the first step for real' : '      awe check         shows what is missing');
  return { output: lines.join('\n'), code: 0, warnings: [] };
}

async function checkCommand({ dir, flags }, cwd) {
  const { entry, tree, promptIds, warnings } = await prepare(cwd, dir);
  const plan = getPlan(tree);
  const names = new Set(['run', ...promptIds.map(id => entry.settings.steps[id]?.executor ?? 'run')]);
  const executors = [];
  for (const name of names) {
    const spec = name === 'run' ? entry.settings.run : entry.settings.executors.get(name);
    if (!spec) { executors.push({ name, display: null, executable: null, found: null }); continue; }
    const found = await findExecutable(spec.argv[0], { cwd: entry.root });
    executors.push({ name, display: resolveExecutor(entry.settings, '', { executor: name }, entry.root).display, executable: spec.argv[0], found });
  }
  const used = executors.filter(item => item.name !== 'run' || promptIds.some(id => (entry.settings.steps[id]?.executor ?? 'run') === 'run'));
  const problems = used.filter(item => !item.display || !item.found);
  // The exit code answers "is the workflow valid?" (invalid workflows throw, exit 2). A missing executor is
  // reported but does not fail the check, so CI machines without an AI CLI can still validate workflows.
  const entryChars = entry.instructions.length;
  const result = { valid: true, ready: problems.length === 0, workflow: entry.root, entry: { characters: entryChars, addedToSteps: promptIds.length }, promptSteps: promptIds.length, plan, executors: used };
  if (flags.json) return { output: JSON.stringify(result, null, 2), code: 0, warnings };
  const lines = [`VALID ${path.relative(cwd, entry.entryFile) || 'ENTRY.md'} (${promptIds.length} prompt steps)`];
  lines.push(`ENTRY.md  ${entryChars} characters, added to the prompt of every step${entryChars > 4000 ? '. That is large: every step pays for it, and any edit reruns every step' : ''}`, prettyPlan(plan), '');
  for (const item of used) {
    if (!item.display) lines.push(`Executor  ${item.name}: NOT CONFIGURED`);
    else lines.push(`Executor  ${item.name}: ${item.display}   ${item.found ? `(found: ${item.found})` : `NOT READY — "${item.executable}" was not found on PATH`}`);
  }
  if (used.some(item => !item.display)) {
    lines.push('', noExecutorError(entry.settings).message);
  } else if (problems.length) {
    lines.push('', 'Install the command, or change "run" in awe.json. You can still preview prompts with: awe run --dry');
  } else {
    lines.push('', 'Next  awe run --dry   ·   awe run 1.1');
  }
  return { output: lines.join('\n'), code: 0, warnings };
}

async function runCommand({ dir, step, flags }, cwd, options) {
  const { entry, tree, promptIds, sources, outputs, warnings } = await prepare(cwd, dir);
  const target = step ? parseStepArg(step) : undefined;

  if (flags.dry) {
    const rendered = await dryRun(entry, tree, { input: flags.input, step: target?.step, sources, outputs });
    if (flags.json) return { output: JSON.stringify({ dry: true, steps: rendered }, null, 2), code: 0, warnings };
    const body = rendered.map(item => `──── ${item.id}  ${item.source} ────\n${item.prompt.trimEnd()}`).join('\n\n');
    const note = `DRY RUN — ${rendered.length} prompt${rendered.length === 1 ? '' : 's'} rendered; nothing was executed, no AI calls, no cache written.\nReferences to earlier steps appear as [output of 1.1]. Every IF branch is shown; a LOOP body once.`;
    return { output: `${note}\n\n${body}\n\n${note.split('\n')[0]}`, code: 0, warnings };
  }

  const overrides = { executor: flags.executor, timeoutSeconds: flags.timeout };
  const state = await runWorkflow(entry, tree, {
    resolveExecutor: id => resolveExecutor(entry.settings, id, overrides),
    input: flags.input, signal: options.signal, hooks: options.hooks,
    step: target?.step, iterations: target?.iterations, sources, outputs,
    cache: flags.cache ? true : flags.noCache ? false : undefined,
    retry: flags.retry,
  });
  const code = state.status === 'COMPLETED' ? 0 : state.status === 'INTERRUPTED' ? 130 : 1;
  if (flags.json) return { output: JSON.stringify(state, null, 2), code, warnings };

  const lines = [
    `Workflow  ${path.basename(entry.root)} (${promptIds.length} steps in plan)    Executor  ${describeExecutors(entry.settings, promptIds, overrides, entry.root)}`,
    `Cache     ${cacheLine(state)}`,
    '',
    ...renderSteps(state, entry.root),
    countsLine(state),
  ];
  if (state.error && !(state.invocations ?? []).some(item => item.error?.message === state.error.message)) {
    lines.push(`Error  ${state.error.code}: ${state.error.message}`);
  }
  const next = nextHint(state, promptIds, entry, overrides);
  if (next) lines.push(`Next  ${next}`);
  return { output: lines.join('\n'), code, warnings };
}

function nextHint(state, promptIds, entry, overrides) {
  if (state.status === 'COMPLETED') {
    if (state.target) {
      const following = promptIds[promptIds.indexOf(state.target.step) + 1];
      return following ? `awe show ${state.target.address}   ·   awe run ${following}` : `awe show ${state.target.address}`;
    }
    return 'awe show   ·   awe show <step>';
  }
  // A command that was stopped, timed out or killed may have acted; awe will not resend it unless told to.
  const retry = (state.invocations ?? []).filter(item => item.unknownOutcome).map(item => ` --retry ${displayAddress(item.address)}`).join('');
  if (state.status === 'INTERRUPTED') return state.target ? `awe run ${state.target.address}${retry}` : `awe run --cache${retry}   (reuses the steps that already finished)`;
  const failed = state.error?.step;
  if (!failed) return null;
  const base = failed.split('@')[0];
  if (state.error.code === 'EXECUTOR_TIMEOUT') {
    const current = resolveExecutor(entry.settings, base, overrides).timeoutMs;
    const seconds = value => +(value / 1000).toFixed(1);
    return `awe run ${failed} --timeout ${Math.ceil(seconds(current) * 2)}${retry}    (limit now ${seconds(current)}s)   ·   awe show ${failed} --err`;
  }
  if (state.error.code === 'UNKNOWN_EFFECT') return null;
  return `awe show ${failed} --err   ·   awe run ${failed}${retry}`;
}

async function showCommand({ dir, step, flags }, cwd) {
  const found = await findWorkflowRoot(path.resolve(cwd, dir ?? '.'));
  const root = path.basename(found) === 'ENTRY.md' ? path.dirname(found) : found;
  const target = step ? parseStepArg(step) : null;
  const result = await show(root, {
    step: target?.step, occurrence: target?.iterations ? `${target.step}@${target.iterations.join('.')}` : undefined,
    runId: flags.runId, prompt: flags.prompt, err: flags.err, json: flags.json,
  });
  return { ...result, warnings: [] };
}

export async function cli(argv, cwd = process.cwd(), options = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    // Turn "--executor needs a value" into a list of the names that would work here.
    if (error.hint === '--executor') {
      try {
        const names = [...(await loadEntry(await findWorkflowRoot(cwd))).settings.executors.keys()];
        error.message += `\nAvailable: ${['run', ...names].join(', ')}`;
      } catch { /* not in a workflow: the generic message stands */ }
    }
    throw error;
  }
  if (parsed.command === 'help') {
    return { output: COMMAND_HELP[parsed.topic] ?? HELP, code: 0, warnings: [] };
  }
  if (parsed.command === 'init') return initCommand(parsed, cwd, options);
  if (parsed.command === 'check') return checkCommand(parsed, cwd);
  if (parsed.command === 'show') return showCommand(parsed, cwd);
  return runCommand(parsed, cwd, options);
}

