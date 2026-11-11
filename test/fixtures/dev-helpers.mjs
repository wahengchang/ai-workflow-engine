// Shared helpers for the dev-mode tests. npm test lists the test files explicitly,
// so this helper is never discovered and executed as a test by node --test.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../../src/cli.js';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const agent = path.join(projectRoot, 'test', 'fixtures', 'dev-agent.cjs');
export const flow = JSON.stringify;

// A temporary workflow plus the call log its fake agent writes.
export async function workspace(t, files = {}, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-dev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(os.tmpdir(), `${path.basename(dir)}.calls.jsonl`);
  t.after(() => rm(log, { force: true }));
  const all = { 'ENTRY.md': '# Instructions', 'awe.json': JSON.stringify(config), ...files };
  for (const [name, text] of Object.entries(all)) await put(dir, name, text);
  return { dir, log };
}

export async function put(dir, name, text) {
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), text);
}

export const agentArgs = (log, extra = []) => ['--executor', 'command', '--command', process.execPath, '--arg', agent, '--arg', log, ...extra.flatMap(arg => ['--arg', arg])];

// Runs `awe dev` and returns the stored run state (success or failure alike).
export async function dev(ws, args = [], options = {}) {
  const result = await cli(['dev', ws.dir, ...args, ...(options.noAgent ? [] : agentArgs(ws.log, options.agentExtra)), '--json'], ws.dir, options.cli);
  return { ...JSON.parse(result.output), exitCode: result.code };
}

export async function calls(log) {
  try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

export async function countByStep(log) {
  const counts = {};
  for (const call of await calls(log)) counts[call.step] = (counts[call.step] ?? 0) + 1;
  return counts;
}
