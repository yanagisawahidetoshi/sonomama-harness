import { mkdtemp, cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const source = new URL('../../', import.meta.url).pathname;
export async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'sonomama-risk-'));
  try {
    for (const path of ['apps', 'packages', 'docs', '.harness/config', '.harness/rules', '.harness/skills', '.harness/state/sample-sbi.json', 'tools/harness', 'AGENTS.md', 'package.json', 'pnpm-workspace.yaml']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await cp(join(source, path), join(root, path), { recursive: true });
    }
    await mkdir(join(root, '.harness/runs'), { recursive: true });
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function update(root, path, fn) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  fn(value);
  await writeFile(join(root, path), JSON.stringify(value));
}
export const human = id => () => ({ id, kind: 'human', source: 'test-authenticated-adapter' });
