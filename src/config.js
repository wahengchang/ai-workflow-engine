import { AweError, assertAwe } from './errors.js';
import { splitCommand, displayCommand, fullCommand, usesSchemaPlaceholder } from './command.js';
import { normalizeJsonDeclaration } from './json-output.js';

export const DEFAULT_TIMEOUT_SECONDS = 300;

export const EXECUTOR_EXAMPLES = [
  '"run": "claude -p {prompt}"',
  '"run": "codex exec {prompt}"',
  '"run": "opencode run {prompt}"',
  '"run": "omp -p"',
];

const NAME = /^[A-Za-z][\w-]*$/;

function seconds(value, where) {
  assertAwe(typeof value === 'number' && Number.isFinite(value) && value > 0, 'INVALID_CONFIG', `awe.json ${where} must be a positive number of seconds`);
  return Math.round(value * 1000);
}

// Commands for steps (run, executors) cannot use {schema}/{schema_file}: only the formatter has a schema.
function noSchema(spec, where) {
  if (usesSchemaPlaceholder(spec.argv)) throw new AweError('INVALID_CONFIG', `awe.json ${where}: {schema} and {schema_file} are only for "formatter" commands`);
  return spec;
}

function commandSpec(value, where) {
  if (typeof value === 'string') return { argv: splitCommand(value, `awe.json ${where}`), timeoutMs: undefined };
  assertAwe(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_CONFIG', `awe.json ${where} must be a command string such as "claude -p {prompt}" or an object with "run"`);
  for (const key of Object.keys(value)) assertAwe(['run', 'timeout'].includes(key), 'INVALID_CONFIG', `awe.json ${where} has unsupported key "${key}". Supported: run, timeout`);
  return { argv: splitCommand(value.run, `awe.json ${where}.run`), timeoutMs: value.timeout === undefined ? undefined : seconds(value.timeout, `${where}.timeout`) };
}

// Turns awe.json (version 2, or the deprecated version 1 "executor" block) into one normalized shape.
// Validation of names that depend on the workflow (step ids) happens in the callers that know the tree.
export function normalizeConfig(config) {
  const warnings = [];
  const settings = { common: undefined, input: config.input ?? {}, run: null, timeoutMs: undefined, executors: new Map(), steps: {}, removedEcho: false, warnings, storePrompts: config.storePrompts };
  assertAwe(settings.input && typeof settings.input === 'object' && !Array.isArray(settings.input), 'INVALID_CONFIG', 'awe.json "input" must be an object');

  if (config.executor !== undefined) {
    const legacy = config.executor;
    assertAwe(legacy && typeof legacy === 'object' && !Array.isArray(legacy), 'INVALID_CONFIG', 'awe.json "executor" must be an object');
    if (legacy.type === 'echo') {
      settings.removedEcho = true;
    } else {
      assertAwe(legacy.type === 'command' || legacy.type === undefined, 'INVALID_CONFIG', `awe.json executor.type "${legacy.type}" is no longer supported. Use "run": "<command>"`);
      if (legacy.argv !== undefined) {
        assertAwe(Array.isArray(legacy.argv) && legacy.argv.length > 0 && legacy.argv.every(a => typeof a === 'string'), 'INVALID_CONFIG', 'awe.json executor.argv must be a non-empty array of strings');
        settings.run = { argv: [...legacy.argv] };
      }
      if (legacy.timeoutMs !== undefined) {
        assertAwe(Number.isInteger(legacy.timeoutMs) && legacy.timeoutMs > 0, 'INVALID_CONFIG', 'awe.json executor.timeoutMs must be a positive integer');
        settings.timeoutMs = legacy.timeoutMs;
      }
    }
    const suggestion = settings.run ? `"run": ${JSON.stringify(fullCommand(settings.run.argv))}${settings.timeoutMs ? `, "timeout": ${Math.round(settings.timeoutMs / 1000)}` : ''}` : '"run": "claude -p {prompt}"';
    warnings.push(`awe.json uses the deprecated "executor" block. Replace it with: ${suggestion}`);
  }

  if (config.common !== undefined) {
    const lines = config.common;
    assertAwe(typeof lines === 'string' || (Array.isArray(lines) && lines.every(line => typeof line === 'string')), 'INVALID_CONFIG',
      'awe.json "common" must be a string, or an array of lines. It is added to the prompt of every step.');
    settings.common = Array.isArray(lines) ? lines.join('\n') : lines;
  }
  if (config.run !== undefined) settings.run = noSchema(commandSpec(config.run, 'run'), 'run');
  if (config.formatter !== undefined) {
    assertAwe(typeof config.formatter === 'string', 'INVALID_CONFIG', 'awe.json "formatter" must be a command string such as "claude -p {prompt}". It turns the text of a step that declares "json" into JSON; without it, "run" is used');
    settings.formatter = { argv: splitCommand(config.formatter, 'awe.json formatter') };
  }
  if (config.timeout !== undefined) settings.timeoutMs = seconds(config.timeout, 'timeout');

  if (config.executors !== undefined) {
    assertAwe(config.executors && typeof config.executors === 'object' && !Array.isArray(config.executors), 'INVALID_CONFIG', 'awe.json "executors" must be an object of name -> command');
    for (const [name, spec] of Object.entries(config.executors)) {
      assertAwe(NAME.test(name) && name !== 'run', 'INVALID_CONFIG', `awe.json executors name "${name}" must start with a letter and may not be "run" (that is the default)`);
      settings.executors.set(name, noSchema(commandSpec(spec, `executors.${name}`), `executors.${name}`));
    }
  }

  if (config.steps !== undefined) {
    assertAwe(config.steps && typeof config.steps === 'object' && !Array.isArray(config.steps), 'INVALID_CONFIG', 'awe.json "steps" must be an object keyed by step ID');
    for (const [id, spec] of Object.entries(config.steps)) {
      assertAwe(spec && typeof spec === 'object' && !Array.isArray(spec), 'INVALID_CONFIG', `awe.json steps["${id}"] must be an object`);
      const step = {};
      if (spec.executor !== undefined) {
        assertAwe(typeof spec.executor === 'string', 'INVALID_CONFIG', `awe.json steps["${id}"].executor must be a name from "executors"`);
        assertAwe(spec.executor === 'run' || settings.executors.has(spec.executor), 'INVALID_CONFIG',
          `awe.json steps["${id}"].executor "${spec.executor}" is not defined. Available: ${['run', ...settings.executors.keys()].join(', ')}`);
        step.executor = spec.executor;
      }
      if (spec.timeout !== undefined) step.timeoutMs = seconds(spec.timeout, `steps["${id}"].timeout`);
      if (spec.json !== undefined && spec.json !== false) step.json = normalizeJsonDeclaration(spec.json, `steps["${id}"]`);
      if (spec.formatter !== undefined) {
        assertAwe(typeof spec.formatter === 'string', 'INVALID_CONFIG', `awe.json steps["${id}"].formatter must be a command string`);
        assertAwe(step.json, 'INVALID_CONFIG', `awe.json steps["${id}"].formatter needs "json" in the same step: the formatter is the command that produces its JSON`);
        step.formatter = { argv: splitCommand(spec.formatter, `awe.json steps["${id}"].formatter`) };
      }
      settings.steps[id] = step;
    }
  }
  return settings;
}

export function noExecutorError(settings) {
  const message = settings?.removedEcho
    ? 'awe.json configures the removed echo executor. To preview prompts without calling anything use: awe run --dry\nTo run for real, set a command in awe.json, e.g.'
    : 'No executor configured. To preview prompts without calling anything use: awe run --dry\nTo run for real, add a command to awe.json, e.g.';
  return new AweError('NO_EXECUTOR', `${message}\n  ${EXECUTOR_EXAMPLES[0]}      ${EXECUTOR_EXAMPLES[1]}\n  ${EXECUTOR_EXAMPLES[2]}   ${EXECUTOR_EXAMPLES[3]}    (no {prompt}: the prompt is sent on stdin)`);
}

// Priority: CLI flag > steps.<id> > named executor > top level.
export function resolveExecutor(settings, stepId, overrides = {}, root) {
  const name = overrides.executor ?? settings.steps[stepId]?.executor ?? 'run';
  const base = name === 'run' ? settings.run : settings.executors.get(name);
  if (!base) {
    if (name === 'run') throw noExecutorError(settings);
    throw new AweError('UNKNOWN_EXECUTOR', `Unknown executor "${name}". Available: ${['run', ...settings.executors.keys()].join(', ')}`);
  }
  const timeoutMs = overrides.timeoutSeconds !== undefined ? Math.round(overrides.timeoutSeconds * 1000)
    : settings.steps[stepId]?.timeoutMs ?? base.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000;
  return { name, argv: base.argv, display: displayCommand(base.argv, root), timeoutMs };
}

// The command that turns the text of a step that declares "json" into JSON.
// Priority: steps.<id>.formatter > top-level "formatter" > "run". The prompt is built in; the command may use
// {prompt}, {prompt_file}, {schema} (the declaration as JSON text) and {schema_file} (a file holding it).
export function resolveFormatter(settings, stepId, overrides = {}, root) {
  const base = settings.steps[stepId]?.formatter ?? settings.formatter ?? settings.run;
  if (!base) throw noExecutorError(settings);
  const timeoutMs = overrides.timeoutSeconds !== undefined ? Math.round(overrides.timeoutSeconds * 1000)
    : settings.steps[stepId]?.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000;
  return { name: 'formatter', argv: base.argv, display: displayCommand(base.argv, root), timeoutMs };
}
