// Deterministic substitute for an AI CLI. Used only in tests; never calls an API.
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; });
process.stdin.on('end', async () => {
  if (input.includes('RETURN_PASS')) return process.stdout.write('PASS');
  if (input.includes('RETURN_FAIL')) return process.stdout.write('FAIL');
  if (input.includes('RETRY_ONCE')) {
    const counter = path.join(process.cwd(), '.fake-agent-counter');
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(n + 1));
    return process.stdout.write(n === 0 ? 'FAIL' : 'PASS');
  }
  if (input.includes('DELAY_150')) await new Promise(resolve => setTimeout(resolve, 150));
  const match = /OUTPUT::([^\n]+)/.exec(input);
  process.stdout.write(match ? match[1].trim() : 'DONE');
});
