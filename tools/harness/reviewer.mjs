import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// v1 is deterministic policy review, not an LLM opinion on quality.
export async function review({ workspace, sbi, rules, verification, files = [] }) {
  const reasons = [];
  if (verification.status !== 'PASS') reasons.push('verification has not passed');
  // Files changed under a directory scope are reviewed like listed files.
  const inDirs = files.filter(f => f.status !== 'D' && (sbi.allowedDirs ?? []).some(dir => f.path.startsWith(dir))).map(f => f.path);
  for (const path of new Set([...sbi.allowedFiles, ...inDirs])) {
    try {
      const content = await readFile(join(workspace, path), 'utf8');
      if (!content.trim()) reasons.push(`empty file: ${path}`);
      if (Buffer.byteLength(content) > rules.maxFileBytes) reasons.push(`file too large: ${path}`);
      if (/\b(TODO|FIXME)\b/.test(content)) reasons.push(`unfinished work: ${path}`);
    } catch { reasons.push(`missing file: ${path}`); }
  }
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}
