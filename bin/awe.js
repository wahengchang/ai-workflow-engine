#!/usr/bin/env node
import { cli } from '../src/cli.js';
import { AweError } from '../src/errors.js';
const controller = new AbortController();
let signalCode;
const interrupt = signal => {
  signalCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal];
  controller.abort();
};
const onInt = () => interrupt('SIGINT');
const onTerm = () => interrupt('SIGTERM');
// Executors run in their own process group, so a closed terminal / dropped SSH session
// (SIGHUP) no longer reaches them; treat it as an interruption so they are killed.
const onHup = () => interrupt('SIGHUP');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
process.on('SIGHUP', onHup);
try {
  const result = await cli(process.argv.slice(2), process.cwd(), { signal: controller.signal });
  for (const warning of result.warnings ?? []) console.error(`awe: warning: ${warning}`);
  console.log(result.output);
  process.exitCode = result.code;
} catch (error) {
  // 2: awe could not start (usage, configuration, workflow files). 1: anything unexpected.
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message } }, null, 2));
  else console.error(`awe: ${error.message}`);
  process.exitCode = error instanceof AweError ? 2 : 1;
} finally {
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  process.off('SIGHUP', onHup);
  if (signalCode) process.exitCode = signalCode;
}
