import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';
import { normalizeConfig } from './config.js';

const STRAY_FILE = 'ENTRY.md'; // v0.1's file. Not used any more; only recognised so it is never ignored silently.
const isFile = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

// A workflow is a folder that holds awe.json (it may be just {"version": 2}). The text every step shares
// is its optional "common" field.
export async function loadEntry(target) {
  const absolute = path.resolve(target);
  let info;
  try { info = await stat(absolute); }
  catch { throw new AweError('WORKFLOW_NOT_FOUND', `No such file or directory: ${absolute}`); }
  const root = info.isDirectory() ? absolute : path.dirname(absolute);
  if (!info.isDirectory()) assertAwe(path.basename(absolute) === 'awe.json', 'INVALID_ENTRY', 'Pass a workflow folder (the one holding awe.json)');
  const configFile = path.join(root, 'awe.json');
  const hasStray = await isFile(path.join(root, STRAY_FILE));
  if (!(await isFile(configFile))) {
    throw new AweError('WORKFLOW_NOT_FOUND', hasStray
      ? `${root} has an ENTRY.md but no awe.json. awe no longer uses ENTRY.md: create awe.json containing {"version": 2, "common": "<the text of ENTRY.md>"} (or "common": ["line 1", "line 2"]), then delete ENTRY.md.`
      : `${root} is not a workflow: it has no awe.json.\nNext: create one with awe init <dir>, or add an awe.json containing {"version": 2} to this folder.`);
  }
  let config;
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (error) {
    throw new AweError('INVALID_CONFIG', `Invalid awe.json: ${error.message}`);
  }
  assertAwe(typeof config === 'object' && config !== null && !Array.isArray(config), 'INVALID_CONFIG', 'awe.json must be an object');
  assertAwe(config.version === undefined || config.version === 1 || config.version === 2, 'INVALID_CONFIG', `Unsupported awe.json version ${JSON.stringify(config.version)}. Use "version": 2`);
  const settings = normalizeConfig(config);
  if (hasStray) settings.warnings.push('ENTRY.md is no longer used, so its text is not sent to any step. Move it into awe.json as "common" (a string, or an array of lines), then delete the file.');
  return { root, entryFile: configFile, common: settings.common ?? '', commonLabel: '"common" in awe.json', config, settings };
}

// Walks up from `start` to the nearest folder that holds awe.json, so awe works from any sub-folder of a
// workflow. `start` may also be a file inside one.
export async function findWorkflowRoot(start) {
  let current = path.resolve(start);
  try {
    if (!(await stat(current)).isDirectory()) return current;
  } catch {
    throw new AweError('WORKFLOW_NOT_FOUND', `No such file or directory: ${current}`);
  }
  for (;;) {
    if (await isFile(path.join(current, 'awe.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new AweError('WORKFLOW_NOT_FOUND', `Not inside a workflow (no awe.json in ${path.resolve(start)} or its parents).\nNext: cd into a workflow, pass its folder (awe run <dir>), create one with awe init <dir>, or add an awe.json containing {"version": 2} to an existing folder of prompts.`);
    }
    current = parent;
  }
}
