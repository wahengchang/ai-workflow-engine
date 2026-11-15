// Stand-in for a formatter command in tests. It never calls an API.
// It takes the text between the TEXT markers and returns:
//   - the JSON after a "FORMAT_TO::" directive in that text, if there is one (the "model" turned prose into JSON);
//   - otherwise the text itself (so a test controls exactly what comes back).
// Switches, as files in the workflow folder (its working directory):
//   formatter.fail  -> answers with something that is not JSON
//   formatter.slow  -> waits 3 s before answering
// argv[2] is a JSONL call log.
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  if (process.argv[2]) fs.appendFileSync(process.argv[2], `${JSON.stringify({ step: process.env.AWE_STEP, address: process.env.AWE_ADDRESS, prompt: input })}\n`);
  if (fs.existsSync('formatter.slow')) await new Promise(resolve => setTimeout(resolve, 3000));
  if (fs.existsSync('formatter.fail')) { process.stdout.write('Sorry, I cannot do that.'); return; }
  const block = /--- TEXT START ---\n([\s\S]*)\n--- TEXT END ---/.exec(input);
  const text = block ? block[1] : 'NO TEXT BLOCK';
  const directive = /FORMAT_TO::([^\n]*)/.exec(text);
  process.stdout.write(directive ? directive[1] : text);
});
