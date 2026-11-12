// Runs `awe run` in-process and kills itself with SIGKILL at a chosen commit stage, to
// simulate a crash at that exact boundary. Usage: node crash.mjs <dir> <stage> <awe run args...>
import { cli } from '../src/cli.js';

const [dir, stage, ...args] = process.argv.slice(2);
const hooks = { [stage]: () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); } };
const result = await cli(['run', dir, ...args], dir, { hooks });
console.log(result.output);
