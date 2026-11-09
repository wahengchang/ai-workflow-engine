import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

// Stable JSON: object keys are sorted so equal data always hashes equally.
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const digestOf = value => sha256(canonical(value));

// Keyed digest for values that may carry credentials (executor argv, inputs).
export const secretDigest = (salt, value) => createHmac('sha256', salt).update(canonical(value)).digest('hex');

export async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}
