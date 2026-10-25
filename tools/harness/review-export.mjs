import { mkdtemp, readdir, lstat, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { withEvidenceProtection, isSecretPath, redactText, discoverEvidenceSecrets } from './evidence-protection.mjs';
import { runPaths } from './run-store.mjs';
import { execute, exists, json } from './io.mjs';
// Re-scan even old evidence; never archive .git objects, approval keys, or raw binary files.
export async function exportRun({ root, runId, out }) {
  return withEvidenceProtection(root, async () => {
    const { directory } = runPaths(root, runId);
    const path = resolve(out || join(root, '.harness/exports', `${runId}.zip`));
    if (!await exists(directory)) throw new Error('Unknown run');
    await discoverEvidenceSecrets(directory);
    if (!relative(directory, path).startsWith('..')) throw new Error('Export path must be outside the run');
    if (await exists(path)) throw new Error('Export already exists; choose a new output path');
    const temp = await mkdtemp(join(tmpdir(), 'harness-review-export-'));
    const excluded = [], included = [];
    try {
      async function copy(from, to, prefix = '') {
        for (const name of await readdir(from)) {
          const source = join(from,name), dest = join(to,name), rel = prefix ? `${prefix}/${name}` : name;
          const info = await lstat(source);
          if (['.git','node_modules','.operation-lock'].includes(name) || isSecretPath(rel) || info.isSymbolicLink()) { excluded.push({path:rel,reason:'protected or secret path'}); continue; }
          if (info.isDirectory()) { await mkdir(dest,{recursive:true}); await copy(source,dest,rel); }
          else if (info.isFile()) {
            if (info.size > 10*1024*1024) { excluded.push({path:rel,reason:'file too large'}); continue; }
            const bytes = await readFile(source);
            if (bytes.includes(0)) { excluded.push({path:rel,reason:'binary file'}); continue; }
            const text = bytes.toString('utf8');
            const safe = name.endsWith('.json') ? JSON.stringify((await import('./evidence-protection.mjs')).redact(JSON.parse(text)),null,2) + '\n' : redactText(text);
            await writeFile(dest,safe); included.push(rel);
          }
        }
      }
      await copy(directory,temp);
      await json(join(temp,'export-manifest.json'),{runId,included,excluded,redaction:true,containsGitObjects:false});
      await mkdir(dirname(path),{recursive:true});
      const result = await execute('zip',['-q','-r',path,'.'],{cwd:temp});
      if (!result.ok) throw new Error('Review ZIP creation failed');
      return {path,included:included.length,excluded:excluded.length};
    } finally { await rm(temp,{recursive:true,force:true}); }
  });
}
