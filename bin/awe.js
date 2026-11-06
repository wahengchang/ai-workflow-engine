#!/usr/bin/env node
import { cli } from '../src/cli.js';
try {
  const result = await cli(process.argv.slice(2));
  console.log(result.output);
  process.exitCode = result.code;
} catch (error) {
  console.error(`awe: ${error.code ?? 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
