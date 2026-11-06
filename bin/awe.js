#!/usr/bin/env node
import { cli } from '../src/cli.js';
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
  console.log(result.output);
  process.exitCode = result.code;
} catch (error) {
  console.error(`awe: ${error.code ?? 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  process.off('SIGHUP', onHup);
  if (signalCode) process.exitCode = signalCode;
}
