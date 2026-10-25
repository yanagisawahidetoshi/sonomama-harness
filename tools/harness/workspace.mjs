import { mkdir, readdir, readFile, lstat, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isSecretPath, hasSecret } from './evidence-protection.mjs';
import { execute, exists } from './io.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=SONOMAMA Harness', '-c', 'user.email=harness@localhost'];
export async function git(workspace, args, optional = false) {
  const result = await execute('git', [...gitOptions, ...args], { cwd: workspace });
  if (!result.ok && !optional) throw new Error(`git ${args[0]}: ${result.stderr || result.error}`);
  return result;
}
async function copyTree(from, to, sourceRoot, exclusions) {
  const relative = from.slice(sourceRoot.length + 1);
  if (isSecretPath(relative)) { exclusions.push({ path: relative, reason: 'prohibited secret path' }); return; }
  const info = await lstat(from);
  if (info.isSymbolicLink()) throw new Error(`workspace source symlink is not permitted: ${from}`);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (['node_modules', '.git', '.harness', 'sources'].includes(name)) continue;
      await copyTree(join(from, name), join(to, name), sourceRoot, exclusions);
    }
  } else if (info.isFile()) {
    if (info.size > 10 * 1024 * 1024) throw new Error(`workspace source exceeds 10 MiB: ${from}`);
    const bytes = await readFile(from);
    if (hasSecret(bytes.toString('utf8'))) { exclusions.push({ path: relative, reason: 'credential content detected' }); return; }
    await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
  } else throw new Error(`unsupported workspace source: ${from}`);
}
export function assertWritablePath(path, { allowSensitiveDeclaration = false } = {}) {
  if (!allowSensitiveDeclaration && isSecretPath(path)) throw new Error('scope/path is a prohibited secret file');
  if (/(^|\/)(\.git|\.harness|node_modules|sources|tools)(\/|$)|(^|\/)AGENTS\.md$|\.(test|spec)\.[^/]+$/.test(path)) throw new Error(`scope/path is reserved: ${path}`);
}
export async function prepareWorkspace(root, workspace, sbi) {
  await mkdir(workspace, { recursive: true });
  const exclusions = [];
  for (const path of ['apps', 'packages', 'docs', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', ...sbi.allowedFiles]) {
    if (await exists(join(root, path))) await copyTree(join(root, path), join(workspace, path), root, exclusions);
  }
  const { json } = await import('./io.mjs');
  await json(join(workspace, '..', 'workspace-exclusions.json'), exclusions);
  await git(workspace, ['init', '--template=', '--initial-branch=harness']);
  await commitWorkspace(workspace, 'Harness baseline');
  return (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
}
export async function commitWorkspace(workspace, message, allowedFiles = []) {
  await git(workspace, ['add', '--all']);
  for (const path of allowedFiles) if (await exists(join(workspace, path))) await git(workspace, ['add', '--force', '--', path]);
  await git(workspace, ['commit', '--allow-empty', '-m', message]);
  return (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
}
export async function workspaceIntegrity(workspace, headSha) {
  const current = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await git(workspace, ['status', '--porcelain', '--untracked-files=all'])).stdout;
  if (current !== headSha || dirty) throw new Error('HEAD/snapshot changed; checks and approvals must be regenerated in a new run');
}
export async function changedFiles(workspace, baselineSha, headSha) {
  const names = (await git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', baselineSha, headSha])).stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < names.length; i += 2) {
    const status = names[i], path = names[i + 1];
    const diff = (await git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', baselineSha, headSha, '--', path])).stdout;
    const lines = diff.split('\n');
    const tree = (await git(workspace, ['ls-tree', headSha, '--', path])).stdout;
    files.push({ path, status, mode: tree.slice(0, 6), modeChanged: /^old mode /m.test(diff), binary: diff.includes('Binary files '),
      added: lines.filter(s => s.startsWith('+') && !s.startsWith('+++')).map(s => s.slice(1)).join('\n'),
      deleted: lines.filter(s => s.startsWith('-') && !s.startsWith('---')).map(s => s.slice(1)).join('\n') });
  }
  return files;
}
export async function toolFingerprint(root) {
  const content = [];
  async function collect(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      if (info.isDirectory()) await collect(path);
      else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) content.push([path.slice(root.length), await readFile(path, 'utf8')]);
    }
  }
  await collect(join(root, 'tools/harness'));
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    if (await exists(join(root, name))) content.push([name, await readFile(join(root, name), 'utf8')]);
  }
  return digest(content);
}
// Bind source even when an app .gitignore would otherwise hide a runtime input.
export async function workspaceFingerprint(workspace) {
  const manifest = [];
  async function collect(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (['.git', 'node_modules'].includes(name)) continue;
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`workspace symlink is not permitted: ${relative}`);
      if (info.isDirectory()) await collect(path, relative);
      else if (info.isFile()) manifest.push([relative, info.mode & 0o777, createHash('sha256').update(await readFile(path)).digest('hex')]);
      else throw new Error(`unsupported workspace entry: ${relative}`);
    }
  }
  await collect(workspace);
  return digest(manifest);
}
