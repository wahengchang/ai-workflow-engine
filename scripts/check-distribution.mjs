import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run via "npm run test:distribution"; always use npm's own CLI to remain portable.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && npmCli.endsWith('.js'), 'Run via npm run test:distribution so npm_execpath points to npm-cli.js');
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(metadata.bin?.awe, './bin/awe.js');

const skill = readFileSync(path.join(root, '.agents/skills/awe/SKILL.md'), 'utf8');
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
assert.ok(frontmatter, 'SKILL.md requires YAML frontmatter');
const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
const compatibility = frontmatter[1].match(/^compatibility:\s*(.+)$/m)?.[1]?.trim();
assert.equal(name, 'awe');
assert.equal(name, path.basename(path.join(root, '.agents/skills/awe')), 'Skill name must match its directory name');
assert.ok(!compatibility || compatibility.length <= 500, 'Skill compatibility must be at most 500 characters');
assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.ok(description && description.length <= 1024, 'Skill description must explain when to use AWE');

function runNpm(args, cwd = root, extraEnv = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: path.join(temp, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', ...extraEnv },
  }).trim();
}
function runBin(base, args) {
  const bin = path.join(base, 'node_modules', '@wahengchang', 'ai-workflow-engine', 'bin', 'awe.js');
  return execFileSync(process.execPath, [bin, ...args], { cwd: base, encoding: 'utf8' });
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'awe-pack-check-'));
try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp]));
  assert.equal(packed.length, 1, 'npm pack should create exactly one tarball');
  const items = packed[0].files.map(f => f.path);
  for (const expected of ['package.json', 'bin/awe.js', 'src/runtime.js', 'README.md', 'docs/installation.md', 'docs/maintenance.md', 'examples/content-generation/ENTRY.md']) {
    assert.ok(items.includes(expected), `Missing from npm package: ${expected}`);
  }
  const excluded = items.filter(p => /(^|\/)(\.awe|\.git|node_modules|test|fixtures|\.github|scripts|\.agents)(\/|$)/.test(p) || /(^|\/)(\.env|\.npmrc)(\.|$)/.test(p));
  assert.deepEqual(excluded, [], `Unexpected development or sensitive files in npm package: ${excluded.join(', ')}`);

  const prefix = path.join(temp, 'isolated');
  const tarball = path.join(temp, packed[0].filename);
  runNpm(['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error', tarball]);
  assert.match(runBin(prefix, ['--help']), /awe/i);
  const example = path.join(prefix, 'node_modules', '@wahengchang', 'ai-workflow-engine', 'examples', 'content-generation', 'ENTRY.md');
  assert.match(runBin(prefix, ['validate', example]), /VALID/);
  assert.match(runBin(prefix, ['plan', example]), /1\.1/);

  // Exercise npm's actual bin resolution, not just node <installed>/bin/awe.js.
  assert.match(runNpm(['exec', '--prefix', prefix, '--offline', '--', 'awe', '--help'], temp), /awe/i);
  assert.match(runNpm(['exec', '--prefix', prefix, '--offline', '--', 'awe', 'validate', example], temp), /VALID/);
  assert.match(runNpm(['exec', '--prefix', prefix, '--offline', '--', 'awe', 'plan', example], temp), /1\.1/);

  const globalPrefix = path.join(temp, 'global');
  runNpm(['install', '--global', '--prefix', globalPrefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const globalModules = process.platform === 'win32' ? path.join(globalPrefix, 'node_modules') : path.join(globalPrefix, 'lib', 'node_modules');
  const shim = process.platform === 'win32' ? path.join(globalPrefix, 'awe.cmd') : path.join(globalPrefix, 'bin', 'awe');
  assert.ok(existsSync(shim), 'Global npm install must create an awe command shim');
  const globalBin = path.join(globalModules, '@wahengchang', 'ai-workflow-engine', 'bin', 'awe.js');
  const globalExample = path.join(globalModules, '@wahengchang', 'ai-workflow-engine', 'examples', 'content-generation', 'ENTRY.md');
  for (const args of [['--help'], ['validate', globalExample], ['plan', globalExample]]) {
    assert.ok(execFileSync(process.execPath, [globalBin, ...args], { cwd: temp, encoding: 'utf8' }).length);
  }

  const linkPrefix = path.join(temp, 'linked');
  runNpm(['link', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], root, { npm_config_prefix: linkPrefix });
  const linkedModules = process.platform === 'win32' ? path.join(linkPrefix, 'node_modules') : path.join(linkPrefix, 'lib', 'node_modules');
  const linkedBin = path.join(linkedModules, '@wahengchang', 'ai-workflow-engine', 'bin', 'awe.js');
  assert.match(execFileSync(process.execPath, [linkedBin, '--help'], { cwd: temp, encoding: 'utf8' }), /awe/i);
  assert.match(execFileSync(process.execPath, [linkedBin, 'validate', path.join(root, 'examples/content-generation/ENTRY.md')], { cwd: temp, encoding: 'utf8' }), /VALID/);
  assert.match(execFileSync(process.execPath, [linkedBin, 'plan', path.join(root, 'examples/content-generation/ENTRY.md')], { cwd: temp, encoding: 'utf8' }), /1\.1/);

  // A local tarball verifies scoped-package binary selection without claiming
  // that the package has been published to the npm registry.
  assert.match(runNpm(['exec', '--yes', '--offline', `--package=${tarball}`, '--', 'awe', '--help'], temp), /awe/i);
  assert.match(runNpm(['exec', '--yes', '--offline', `--package=${tarball}`, '--', 'awe', 'validate', example], temp), /VALID/);
  assert.match(runNpm(['exec', '--yes', '--offline', `--package=${tarball}`, '--', 'awe', 'plan', example], temp), /1\.1/);
  console.log(`Distribution check passed (${items.length} files): packed, local/global installed, source linked, and npm exec launched awe offline.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
