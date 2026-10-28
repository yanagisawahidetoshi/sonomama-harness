import { mkdir, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isSecretPath, hasSecret, isSafeEnvTemplate } from './evidence-protection.mjs';
import { execute, exists } from './io.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=SONOMAMA Harness', '-c', 'user.email=harness@localhost'];
export async function git(workspace, args, optional = false) {
  const result = await execute('git', [...gitOptions, ...args], { cwd: workspace });
  if (!result.ok && !optional) throw new Error(`git ${args[0]}: ${result.stderr || result.error}`);
  return result;
}
export function assertWritablePath(path, { allowSensitiveDeclaration = false } = {}) {
  if (!allowSensitiveDeclaration && isSecretPath(path)) throw new Error('scope/path is a prohibited secret file');
  if (/(^|\/)(\.git|\.harness|\.github|\.githooks|\.ai|node_modules|sources|tools)(\/|$)|(^|\/)AGENTS\.md$/.test(path)) throw new Error(`scope/path is reserved: ${path}`);
  if (/\.(test|spec)\.[^/]+$/.test(path) && !/^(apps|packages|prototypes)\//.test(path)) throw new Error(`trusted test path is reserved: ${path}`);
}
export async function sourceIntegrity(root, baselineSha) {
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=all'])).stdout;
  if (dirty || (baselineSha && head !== baselineSha)) {
    // Uncommitted files alone can be cleaned up and retried; a moved HEAD cannot.
    throw Object.assign(new Error('Source must be clean; uncommitted inputs or source HEAD changed'), { code: baselineSha && head === baselineSha ? 'SOURCE_DIRTY' : 'SOURCE_CHANGED' });
  }
  return head;
}
export async function prepareWorkspace(root, workspace) {
  const baseline = await sourceIntegrity(root);
  // Never materialize committed credentials/operational data in an agent worktree.
  const names = (await git(root, ['ls-tree', '-r', '--name-only', '-z', baseline])).stdout.split('\0').filter(Boolean);
  for (const path of names) {
    if (/^\.harness\/(state\/human|state\/runs|runs|exports)\//.test(path) && !path.endsWith('/.gitkeep')) throw new Error('tracked operational evidence is prohibited');
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('tracked symlink is not permitted in a worktree');
    const content = (await readFile(join(root, path))).toString('utf8');
    if (isSafeEnvTemplate(path,content)) continue;
    const trustedSource = /^tools\/harness\/.*\.test\.mjs$/.test(path);
    const credentialFound = trustedSource ? /gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n/.test(content) : hasSecret(content);
    if (isSecretPath(path) || credentialFound) throw new Error('tracked credential detected; remove sensitive material before creating a worktree');
  }
  await mkdir(dirname(workspace), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', workspace, baseline]);
  const { json } = await import('./io.mjs');
  await json(join(workspace, '..', 'workspace-exclusions.json'), []);
  return baseline;
}
export async function assertWorktreeOwner(root, workspace, baselineSha) {
  const source = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  const target = (await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  if (source !== target || await realpath(root) === await realpath(workspace)) throw new Error('workspace is not an owned Git worktree');
  await git(workspace, ['merge-base', '--is-ancestor', baselineSha, 'HEAD']);
}
export async function commitWorkspace(workspace, message, allowedFiles = []) {
  await git(workspace, ['add', '--all']);
  for (const path of allowedFiles) if (await exists(join(workspace, path))) await git(workspace, ['add', '--force', '--', path]);
  await git(workspace, ['commit', '--allow-empty', '-m', message]);
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const runId = dirname(workspace).split('/').at(-1);
  await git(workspace, ['update-ref', `refs/harness/runs/${runId}`, head]);
  return head;
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
  if (await exists(join(root, '.harness/verification'))) await collect(join(root, '.harness/verification'));
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
