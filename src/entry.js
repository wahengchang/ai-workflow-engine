import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';

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
  assertAwe(!config.version || config.version === 1, 'INVALID_CONFIG', 'Unsupported awe.json version');
  return { root, entryFile, instructions, config };
}
