// Slow deterministic executor for cancellation tests: sleeps N ms then echoes
// a fixed token, without reading the prompt. Zero network.
const args = process.argv.slice(2);
const delay = Number(args[0]) || 400;
setTimeout(() => {
  process.stdout.write('SLOW-DONE\n');
  process.exit(0);
}, delay);
