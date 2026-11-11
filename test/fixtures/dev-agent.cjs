// Deterministic stand-in for an AI CLI used by the dev-mode tests. It never calls an API.
// argv[2] is a JSONL call log. Directives are read from the prompt it receives on stdin:
//   OUTPUT::text            reply text ("{n}" = how many times this step has now run)
//   OUTPUT_FROM::file       reply with the contents of a workspace file
//   WRITE::path::text       write a workspace file ("{n}" is replaced too)
//   WRITEBYTES::path::hex   write a binary workspace file
//   PASS_IF_NUM_GTE::k::t   reply PASS when the last integer in t is >= k, else FAIL
//   FAIL_IF_EXISTS::file    exit 3 while the workspace file exists
//   SYMLINK::path::target   make a workspace symlink (replacing any file)
//   APPEND::file::text      append a line to a workspace file (an external effect)
//   SELF_KILL::             die from SIGKILL after the effects above, as an OOM kill would
//   SLEEP::ms               wait before replying
//   SLEEP_WHILE::file::ms   wait only while the workspace file exists
const fs = require('node:fs');
const path = require('node:path');
const logFile = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const step = /^# Step (\S+) /m.exec(input)?.[1] ?? '?';
  let n = 1;
  if (logFile) {
    const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    n = previous.filter(entry => entry.step === step).length + 1;
    fs.appendFileSync(logFile, JSON.stringify({ step, n, prompt: input }) + '\n');
  }
  const fill = text => text.replaceAll('{n}', String(n));
  const guard = /FAIL_IF_EXISTS::([^\s]+)/.exec(input);
  if (guard && fs.existsSync(path.join(process.cwd(), guard[1]))) {
    process.stderr.write(`blocked by ${guard[1]}`);
    process.exit(3);
  }
  const sleep = /SLEEP::(\d+)/.exec(input);
  if (sleep) await new Promise(resolve => setTimeout(resolve, Number(sleep[1])));
  const slowWhile = /SLEEP_WHILE::([^:\s]+)::(\d+)/.exec(input);
  if (slowWhile && fs.existsSync(path.join(process.cwd(), slowWhile[1]))) await new Promise(resolve => setTimeout(resolve, Number(slowWhile[2])));
  for (const match of input.matchAll(/WRITE::([^:\n]+)::([^\n]*)/g)) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), match[1])), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), match[1]), fill(match[2]));
  }
  for (const match of input.matchAll(/WRITEBYTES::([^:\n]+)::([0-9a-f]*)/g)) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), match[1])), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), match[1]), Buffer.from(match[2], 'hex'));
  }
  for (const match of input.matchAll(/APPEND::([^:\n]+)::([^\n]*)/g)) fs.appendFileSync(path.join(process.cwd(), match[1]), `${fill(match[2])}\n`);
  if (/SELF_KILL::/.test(input)) process.kill(process.pid, 'SIGKILL');
  for (const match of input.matchAll(/SYMLINK::([^:\n]+)::([^\n]*)/g)) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), match[1])), { recursive: true });
    fs.rmSync(path.join(process.cwd(), match[1]), { force: true });
    fs.symlinkSync(match[2], path.join(process.cwd(), match[1]));
  }
  const from = /OUTPUT_FROM::([^\s]+)/.exec(input);
  if (from) return process.stdout.write(fs.readFileSync(path.join(process.cwd(), from[1]), 'utf8').trim());
  const gate = /PASS_IF_NUM_GTE::(\d+)::([^\n]*)/.exec(input);
  if (gate) {
    const numbers = gate[2].match(/\d+/g) ?? ['0'];
    return process.stdout.write(Number(numbers.at(-1)) >= Number(gate[1]) ? 'PASS' : 'FAIL');
  }
  const output = /OUTPUT::([^\n]*)/.exec(input);
  process.stdout.write(output ? fill(output[1]).trim() : 'DONE');
});
