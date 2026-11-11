// Deterministic executor used by partial-rerun tests to force IF/LOOP verdicts.
// Reads the prompt from stdin but answers purely from argv; zero network.
const fs = require('node:fs');
const args = process.argv.slice(2);
function flag(name) {
  const prefix = `--${name}`;
  const hit = args.indexOf(prefix);
  if (hit >= 0) return args[hit + 1] ?? '';
  const inline = args.find(a => a.startsWith(`${prefix}=`));
  return inline === undefined ? undefined : inline.slice(prefix.length + 1);
}
function main() {
  const say = flag('say');
  if (say !== undefined) {
    process.stdout.write(say + '\n');
    process.exit(0);
  }
  const passOn = Number(flag('pass-on'));
  if (Number.isInteger(passOn) && passOn >= 1) {
    let file = flag('state');
    if (!file) file = process.cwd() + '/.say-state/verdict.txt';
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    const prior = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || '0' : '0');
    const count = prior + 1;
    fs.writeFileSync(file, String(count));
    process.stdout.write((count >= passOn ? 'PASS' : 'PENDING') + '\n');
    process.exit(0);
  }
  process.exit(2);
}
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', main);
