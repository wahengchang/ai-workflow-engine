import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';
import { normalizeConfig } from './config.js';

const LEGACY_FILE = 'ENTRY.md';
const isFile = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

// A workflow is a folder that holds awe.json (it may be just {"version": 2}). The text every step shares
// is its "common" field. The v0.1 ENTRY.md still works as a deprecated stand-in for both.
export async function loadEntry(target) {
  const absolute = path.resolve(target);
  let info;
  try { info = await stat(absolute); }
  catch { throw new AweError('WORKFLOW_NOT_FOUND', `No such file or directory: ${absolute}`); }
  const root = info.isDirectory() ? absolute : path.dirname(absolute);
  if (!info.isDirectory()) assertAwe(['awe.json', LEGACY_FILE].includes(path.basename(absolute)), 'INVALID_ENTRY', 'Pass a workflow folder (the one holding awe.json)');
  const configFile = path.join(root, 'awe.json');
  const hasConfig = await isFile(configFile);
  const legacyFile = path.join(root, LEGACY_FILE);
  const hasLegacy = await isFile(legacyFile);
  if (!hasConfig && !hasLegacy) {
    throw new AweError('WORKFLOW_NOT_FOUND', `${root} is not a workflow: it has no awe.json.\nNext: create one with awe init <dir>, or add an awe.json containing {"version": 2} to this folder.`);
  }
  let config = {};
  if (hasConfig) {
    try {
      config = JSON.parse(await readFile(configFile, 'utf8'));
    } catch (error) {
      throw new AweError('INVALID_CONFIG', `Invalid awe.json: ${error.message}`);
    }
  }
  assertAwe(typeof config === 'object' && config !== null && !Array.isArray(config), 'INVALID_CONFIG', 'awe.json must be an object');
  assertAwe(config.version === undefined || config.version === 1 || config.version === 2, 'INVALID_CONFIG', `Unsupported awe.json version ${JSON.stringify(config.version)}. Use "version": 2`);
  const settings = normalizeConfig(config);
  let common = settings.common ?? '';
  let commonLabel = '"common" in awe.json';
  if (hasLegacy) {
    if (settings.common === undefined) {
      common = await readFile(legacyFile, 'utf8');
      commonLabel = LEGACY_FILE;
      settings.warnings.push('ENTRY.md is deprecated. Move its text into awe.json as "common" (a string, or an array of lines), then delete the file.');
    } else {
      settings.warnings.push('ENTRY.md is ignored because awe.json has "common". Delete the file.');
    }
  }
  return { root, entryFile: hasConfig ? configFile : legacyFile, common, commonLabel, config, settings };
}

// Walks up from `start` to the nearest folder that holds awe.json (or the legacy ENTRY.md), so awe works
// from any sub-folder of a workflow. `start` may also be a file inside one.
export async function findWorkflowRoot(start) {
  let current = path.resolve(start);
  try {
    if (!(await stat(current)).isDirectory()) return current;
  } catch {
    throw new AweError('WORKFLOW_NOT_FOUND', `No such file or directory: ${current}`);
  }
  for (;;) {
    if (await isFile(path.join(current, 'awe.json')) || await isFile(path.join(current, LEGACY_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new AweError('WORKFLOW_NOT_FOUND', `Not inside a workflow (no awe.json in ${path.resolve(start)} or its parents).\nNext: cd into a workflow, pass its folder (awe run <dir>), create one with awe init <dir>, or add an awe.json containing {"version": 2} to an existing folder of prompts.`);
    }
    current = parent;
  }
}
