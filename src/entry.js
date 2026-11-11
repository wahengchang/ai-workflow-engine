import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';
import { normalizeConfig } from './config.js';

export async function loadEntry(target) {
  const absolute = path.resolve(target);
  let entryFile;
  try {
    entryFile = (await stat(absolute)).isDirectory() ? path.join(absolute, 'ENTRY.md') : absolute;
  } catch {
    throw new AweError('ENTRY_NOT_FOUND', `Entry does not exist: ${absolute}`);
  }
  assertAwe(path.basename(entryFile) === 'ENTRY.md', 'INVALID_ENTRY', 'Entry must be named ENTRY.md or a directory containing it');
  let instructions;
  try { instructions = await readFile(entryFile, 'utf8'); }
  catch { throw new AweError('ENTRY_NOT_FOUND', `Missing ENTRY.md: ${entryFile}`); }
  assertAwe(instructions.trim().length > 0, 'EMPTY_ENTRY', 'ENTRY.md must contain instructions');
  const root = path.dirname(entryFile);
  let config = {};
  try {
    config = JSON.parse(await readFile(path.join(root, 'awe.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new AweError('INVALID_CONFIG', `Invalid awe.json: ${error.message}`);
  }
  assertAwe(typeof config === 'object' && config !== null && !Array.isArray(config), 'INVALID_CONFIG', 'awe.json must be an object');
  assertAwe(config.version === undefined || config.version === 1 || config.version === 2, 'INVALID_CONFIG', `Unsupported awe.json version ${JSON.stringify(config.version)}. Use "version": 2`);
  return { root, entryFile, instructions, config, settings: normalizeConfig(config) };
}

// Walks up from `start` to the nearest directory containing ENTRY.md, so awe works from any
// sub-folder of a workflow. `start` may also be an ENTRY.md file.
export async function findWorkflowRoot(start) {
  let current = path.resolve(start);
  try {
    if (!(await stat(current)).isDirectory()) return current;
  } catch {
    throw new AweError('ENTRY_NOT_FOUND', `No such file or directory: ${current}`);
  }
  for (;;) {
    try {
      if ((await stat(path.join(current, 'ENTRY.md'))).isFile()) return current;
    } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new AweError('ENTRY_NOT_FOUND', `Not inside a workflow (no ENTRY.md in ${path.resolve(start)} or its parents).\nNext: cd into a workflow, pass its folder (awe run <dir>), or create one with: awe init <dir>`);
    }
    current = parent;
  }
}
