#!/usr/bin/env node
// Shared deterministic executor for the AWE example workflows.
// Zero network, no AI calls: behavior is fully chosen by argv.
// Flags:
//   --say=X       always output X, ignoring stdin content
//   --pass-on=N   count invocations in a state file; output PASS on call N, PENDING before
//   --state=F     optional explicit state file path (absolute recommended)
//   --state-name=NAME  optional state file name under <workflow-root>/.demo-state (default: verdict)
// The state directory is hidden (dotfile), so workflow discovery ignores it either way.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
function flag(name) {
  const prefix = `--${name}`;
  const hit = args.indexOf(prefix);
  if (hit >= 0) return args[hit + 1] ?? '';
  const inline = args.find(a => a.startsWith(`${prefix}=`));
  return inline === undefined ? undefined : inline.slice(prefix.length + 1);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const say = flag('say');
  if (say !== undefined) {
    process.stdout.write(say + '\n');
    process.exit(0);
  }
  const passOn = Number(flag('pass-on'));
  if (Number.isInteger(passOn) && passOn >= 1) {
    let file = flag('state');
    if (!file) {
      const dir = path.join(process.cwd(), '.demo-state');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${flag('state-name') ?? 'verdict'}.txt`);
    }
    const prior = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || '0' : '0');
    const count = prior + 1;
    fs.writeFileSync(file, String(count));
    process.stdout.write((count >= passOn ? 'PASS' : 'PENDING') + '\n');
    process.exit(0);
  }
  process.exit(2);
});
