import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { AweError, assertAwe } from './errors.js';
import { flatten } from './discover.js';
import { hashFile } from './digest.js';

// Declared output files: awe.json -> { "steps": { "<id>": { "outputs": [{ "name", "path" }] } } }.
// Only named regular files are supported (no directories or globs).
const NAME = /^[A-Za-z][\w-]*$/;

function normalizePath(value, where) {
  const bad = reason => new AweError('INVALID_CONFIG', `awe.json ${where}: output path ${JSON.stringify(value)} ${reason}`);
  if (typeof value !== 'string' || value.length === 0) throw bad('must be a non-empty string');
  if (value.includes('\0') || value.includes('\\')) throw bad('must use forward slashes and no control characters');
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw bad('must be relative to the workflow root');
  const normalized = path.posix.normalize(value);
  const segments = normalized.split('/');
  if (normalized === '.' || normalized.endsWith('/')) throw bad('must name a file, not a directory');
  if (segments.includes('..')) throw bad('must stay inside the workflow root');
  if (segments[0] === '.awe') throw bad('must not point into .awe');
  if (/[*?[\]{}]/.test(normalized)) throw bad('must not contain wildcard characters (directories and globs are not supported)');
  return normalized;
}

export function declaredOutputs(config, tree) {
  const outputs = new Map();
  if (config.steps === undefined) return outputs;
  assertAwe(config.steps && typeof config.steps === 'object' && !Array.isArray(config.steps), 'INVALID_CONFIG', 'awe.json "steps" must be an object keyed by step ID');
  const promptIds = new Set(flatten(tree).filter(node => node.type === 'prompt').map(node => node.id));
  for (const [id, spec] of Object.entries(config.steps)) {
    const where = `steps["${id}"]`;
    assertAwe(promptIds.has(id), 'INVALID_CONFIG', `awe.json ${where} does not match a prompt step`);
    assertAwe(spec && typeof spec === 'object' && !Array.isArray(spec), 'INVALID_CONFIG', `awe.json ${where} must be an object`);
    for (const key of Object.keys(spec)) assertAwe(key === 'outputs', 'INVALID_CONFIG', `awe.json ${where} has unsupported key "${key}"`);
    if (spec.outputs === undefined) continue;
    assertAwe(Array.isArray(spec.outputs) && spec.outputs.length > 0, 'INVALID_CONFIG', `awe.json ${where}.outputs must be a non-empty array`);
    const names = new Set();
    const declared = spec.outputs.map(item => {
      assertAwe(item && typeof item === 'object' && !Array.isArray(item), 'INVALID_CONFIG', `awe.json ${where}.outputs entries must be objects`);
      for (const key of Object.keys(item)) assertAwe(['name', 'path'].includes(key), 'INVALID_CONFIG', `awe.json ${where}.outputs entry has unsupported key "${key}"`);
      assertAwe(typeof item.name === 'string' && NAME.test(item.name), 'INVALID_CONFIG', `awe.json ${where}.outputs name must match ${NAME}`);
      assertAwe(!names.has(item.name), 'INVALID_CONFIG', `awe.json ${where} declares output "${item.name}" twice`);
      names.add(item.name);
      return { name: item.name, path: normalizePath(item.path, `${where}.outputs["${item.name}"]`) };
    });
    const paths = new Set();
    for (const item of declared) {
      assertAwe(!paths.has(item.path.toLowerCase()), 'INVALID_CONFIG', `awe.json ${where} declares path ${item.path} twice`);
      paths.add(item.path.toLowerCase());
    }
    outputs.set(id, declared);
  }
  assertNoParallelConflicts(tree, outputs);
  return outputs;
}

const overlaps = (a, b) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};

// Sibling PARALLEL branches run at the same time in one workspace, so two of them
// declaring the same location (or a file inside another's path) is ambiguous.
function assertNoParallelConflicts(tree, outputs) {
  for (const node of flatten(tree)) {
    if (node.type !== 'parallel') continue;
    const branches = node.children.map(child => flatten(child).filter(n => n.type === 'prompt').flatMap(n => (outputs.get(n.id) ?? []).map(o => ({ step: n.id, path: o.path }))));
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        for (const a of branches[i]) {
          for (const b of branches[j]) {
            if (overlaps(a.path, b.path)) throw new AweError('OUTPUT_CONFLICT', `Parallel steps ${a.step} and ${b.step} declare the same output location (${a.path} vs ${b.path}); give each branch its own path`);
          }
        }
      }
    }
  }
}

async function identity(file) {
  try {
    const s = await stat(file, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Remember what each declared location looked like before the executor ran, so a
// file left over from an earlier attempt is never mistaken for this attempt's output.
export async function snapshotOutputs(root, decls) {
  const before = new Map();
  for (const decl of decls) before.set(decl.name, await identity(path.resolve(root, decl.path)));
  return before;
}

const sameIdentity = (a, b) => a && b && Object.keys(a).every(key => a[key] === b[key]);

async function copyWithHash(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  // 'wx' refuses to overwrite: every attempt owns a fresh directory.
  await pipeline(
    createReadStream(source),
    async function* digest(chunks) { for await (const chunk of chunks) { hash.update(chunk); size += chunk.length; yield chunk; } },
    createWriteStream(destination, { flags: 'wx', mode: 0o444 }),
  );
  return { sha256: hash.digest('hex'), size };
}

export async function captureOutputs({ root, stepId, decls, before, destDir }) {
  const realRoot = await realpath(root);
  const files = {};
  const saved = [];
  try {
    for (const decl of decls) {
      const absolute = path.resolve(root, decl.path);
      let real;
      try { real = await realpath(absolute); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new AweError('OUTPUT_MISSING', `Step ${stepId} did not produce declared output "${decl.name}" (${decl.path})`);
        throw error;
      }
      const relative = path.relative(realRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] === '.awe') {
        throw new AweError('OUTPUT_INVALID', `Declared output "${decl.name}" of step ${stepId} resolves outside the workflow root (${decl.path})`);
      }
      const info = await stat(real);
      if (!info.isFile()) throw new AweError('OUTPUT_INVALID', `Declared output "${decl.name}" of step ${stepId} is not a regular file (${decl.path})`);
      if (sameIdentity(before?.get(decl.name), await identity(absolute))) {
        throw new AweError('OUTPUT_STALE', `Declared output "${decl.name}" of step ${stepId} (${decl.path}) was not written by this attempt; it is unchanged from before the step started`);
      }
      const destination = path.join(destDir, `${decl.name}${path.extname(decl.path)}`);
      const copied = await copyWithHash(real, destination);
      saved.push(destination);
      files[decl.name] = { path: destination, source: decl.path, sha256: copied.sha256, size: copied.size };
    }
  } catch (error) {
    await Promise.all(saved.map(file => unlink(file).catch(() => {})));
    throw error;
  }
  return files;
}

// echo never writes files; templates still need something honest to render.
export function simulatedFiles(decls) {
  return Object.fromEntries(decls.map(decl => [decl.name, { path: `[simulated file: ${decl.name}]`, source: decl.path, simulated: true }]));
}

export const filePaths = files => Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.path]));

// Returns null when the stored copy is intact, otherwise a short reason.
export async function verifyStoredFile(file, expected) {
  let info;
  try { info = await stat(file); }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : `unreadable (${error.code})`; }
  if (!info.isFile()) return 'not a regular file';
  if (info.size !== expected.size) return 'size mismatch';
  return (await hashFile(file)).sha256 === expected.sha256 ? null : 'digest mismatch';
}
