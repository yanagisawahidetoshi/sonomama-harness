import { mkdir, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isSecretPath, hasTrackedCredential, isSafeEnvTemplate } from './evidence-protection.mjs';
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
  // Generated Trusted Acceptance (#147) lives in these app directories; only the Harness registration writes there.
  if (/^apps\/[^/]+\/spec\/acceptance(\/|$)|(^|\/)__acceptance__(\/|$)/i.test(path)) throw new Error(`generated acceptance path is reserved: ${path}`);
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
    if (isSecretPath(path) || hasTrackedCredential(path, content)) throw new Error('tracked credential detected; remove sensitive material before creating a worktree');
  }
  await mkdir(dirname(workspace), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', workspace, baseline]);
  const { json } = await import('./io.mjs');
  await json(join(workspace, '..', 'workspace-exclusions.json'), []);
  return baseline;
}
// prepareWorkspace's checks on Git objects, for the files a PR head changes since its merge base with base, before any checkout.
export async function assertSafeCommit(root, base, head) {
  const paths = (await git(root, ['diff', '--no-renames', '--diff-filter=d', '--name-only', '-z', `${base}...${head}`])).stdout.split('\0').filter(Boolean);
  for (const path of paths) {
    if (/^\.harness\/(state\/human|state\/runs|runs|exports)\//.test(path) && !path.endsWith('/.gitkeep')) throw new Error(`tracked operational evidence is prohibited: ${path}`);
    const [mode, , object] = (await git(root, ['ls-tree', head, '--', path])).stdout.split(/\s+/);
    if (mode === '120000') throw new Error(`tracked symlink is not permitted in a worktree: ${path}`);
    if (mode === '160000') throw new Error(`submodule is not permitted in a worktree: ${path}`);
    const content = (await git(root, ['cat-file', 'blob', object])).stdout;
    if (isSafeEnvTemplate(path, content)) continue;
    if (isSecretPath(path) || hasTrackedCredential(path, content)) throw new Error(`tracked credential detected in ${path}; remove sensitive material before creating a worktree`);
  }
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
// #184: what is binary and which lines changed come from the blobs, never from a .gitattributes in the tree under review (an empty attribute source
// and no attributes file), and the lines are read by the hunk headers, so an added line that starts with "++" or spells "Binary files" stays a line.
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const plainDiff = ['--attr-source', emptyTree, '-c', 'core.attributesFile=/dev/null', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
function hunkLines(diff) {
  const added = [], deleted = [], lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
    if (!hunk) continue;
    let minus = Number(hunk[1] ?? 1), plus = Number(hunk[2] ?? 1);
    while ((minus > 0 || plus > 0) && ++i < lines.length) {
      const line = lines[i];
      if (line.startsWith('-') && minus > 0) { deleted.push(line.slice(1)); minus--; }
      else if (line.startsWith('+') && plus > 0) { added.push(line.slice(1)); plus--; }
      else if (!line.startsWith('\\')) throw new Error('git diff: unexpected hunk line');
    }
  }
  return { added, deleted };
}
export async function changedFiles(workspace, baselineSha, headSha) {
  const names = (await git(workspace, [...plainDiff, '--name-status', '-z', baselineSha, headSha])).stdout.split('\0').filter(Boolean);
  // Git counts no lines of a blob with a NUL byte; with no attributes, nothing else makes a file binary.
  const numstat = (await git(workspace, [...plainDiff, '--numstat', '-z', baselineSha, headSha])).stdout.split('\0').filter(Boolean);
  const binary = new Set(numstat.filter(entry => entry.startsWith('-\t-\t')).map(entry => entry.slice(4)));
  const files = [];
  for (let i = 0; i < names.length; i += 2) {
    const status = names[i], path = names[i + 1];
    const diff = (await git(workspace, [...plainDiff, '--unified=0', baselineSha, headSha, '--', path])).stdout;
    const header = diff.split(/^@@ /m)[0];
    const { added, deleted } = binary.has(path) ? { added: [], deleted: [] } : hunkLines(diff);
    const tree = (await git(workspace, ['ls-tree', headSha, '--', path])).stdout;
    files.push({ path, status, mode: tree.slice(0, 6), modeChanged: /^old mode /m.test(header), binary: binary.has(path),
      added: added.join('\n'), deleted: deleted.join('\n'), addedLines: added.length, deletedLines: deleted.length });
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
