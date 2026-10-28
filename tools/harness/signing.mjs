import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

// One local key outside every agent workspace signs the approval ledger and the run state.
export async function signingKey(root, create = false) {
  const path = join(root, '.harness/state/human/.key');
  if (create) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return readFile(path);
}
export const sign = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
