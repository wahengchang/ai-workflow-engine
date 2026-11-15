// A formatter that shows what {schema} and {schema_file} gave it: argv[2] is the schema text, argv[3] a file.
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ arg: process.argv[2], file: fs.readFileSync(process.argv[3], 'utf8') }));
});
