// Shared helpers for the run/cache tests (kept outside test/ so node --test does not run it).
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../src/cli.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const agent = path.join(projectRoot, 'fixtures', 'agent.cjs');
export const flow = JSON.stringify;

// A command string for awe.json "run": node <agent> <log> [extra args], quoted for splitCommand.
export const agentCommand = (log, extra = []) => [process.execPath, agent, log, ...extra].map(token => JSON.stringify(token)).join(' ');

// A temporary workflow plus the call log its fake agent writes. awe.json already points at the agent.
export async function workspace(t, files = {}, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awe-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(os.tmpdir(), `${path.basename(dir)}.calls.jsonl`);
  t.after(() => rm(log, { force: true }));
  const all = { 'ENTRY.md': '# Instructions', 'awe.json': JSON.stringify({ version: 2, run: agentCommand(log), ...config }), ...files };
  for (const [name, text] of Object.entries(all)) await put(dir, name, text);
  return { dir, log };
}

export async function put(dir, name, text) {
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), text);
}

// Runs `awe run` and returns the stored run state (success or failure alike).
export async function run(ws, args = [], options = {}) {
  const result = await cli(['run', ws.dir, ...args, '--json'], ws.dir, options.cli);
  return { ...JSON.parse(result.output), exitCode: result.code };
}

// The old "finish the workflow from what is already valid": a whole run that reads the cache.
export const resume = (ws, args = [], options) => run(ws, ['--cache', ...args], options);

export async function calls(log) {
  try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

export async function countByStep(log) {
  const counts = {};
  for (const call of await calls(log)) counts[call.step] = (counts[call.step] ?? 0) + 1;
  return counts;
}
