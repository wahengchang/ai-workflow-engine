#!/usr/bin/env node
import { cli } from '../src/cli.js';
const controller = new AbortController();
let signalCode;
const interrupt = signal => {
  signalCode = signal === 'SIGINT' ? 130 : 143;
  controller.abort();
};
const onInt = () => interrupt('SIGINT');
const onTerm = () => interrupt('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
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
  if (signalCode) process.exitCode = signalCode;
}
