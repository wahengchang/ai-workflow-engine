import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AweError } from './errors.js';

// Explicit files avoid copying local example runs or other developer content.
const CONTENT_FILES = [
  'ENTRY.md', 'awe.json',
  'stage-1/1.1-research.md', 'stage-1/1.2-outline.md',
  'stage-2/2.1-draft.md',
  'stage-3/3.1-checks/FLOW.json',
  'stage-3/3.1-checks/3.1.1-fact-check.md',
  'stage-3/3.1-checks/3.1.2-editorial-check.md',
  'stage-3/3.2-deliver.md',
];

export async function initWorkflow(destination, template = 'content') {
  if (template !== 'content') throw new AweError('CLI_USAGE', `Unknown template: ${template}. Available: content`);
  const source = fileURLToPath(new URL('../examples/content-generation/', import.meta.url));
  const files = await Promise.all(CONTENT_FILES.map(async name => [name, await readFile(path.join(source, name), 'utf8')]));
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await mkdir(destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new AweError('INIT_EXISTS', `Destination already exists: ${destination}. Choose a new directory; no files were changed.`);
    throw error;
  }
  try {
    for (const [name, content] of files) {
      const file = path.join(destination, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, { flag: 'wx' });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return path.join(destination, 'ENTRY.md');
}
