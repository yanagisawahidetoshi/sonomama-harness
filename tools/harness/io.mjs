import { access, readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact, redactText } from './evidence-protection.mjs';
import { spawn } from 'node:child_process';
export const exists = path => access(path).then(() => true, () => false);
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(redact(value), null, 2) + '\n');
  await rename(temp, path);
}
// No shell expansion. env replaces the inherited environment when given. Bound runtime and captured output; kill the process group on timeout.
export function execute(command, args, { cwd, input = '', timeoutMs = 120000, env } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', error = null, timedOut = false;
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => {
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const collect = key => chunk => {
      if (key === 'out') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) { error = 'process output limit exceeded'; kill(); }
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', e => { error = e.message; });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, error, stdout: stdout.slice(0, 1024 * 1024), stderr: stderr.slice(0, 1024 * 1024), ok: code === 0 && !error && !timedOut });
    });
    child.stdin.end(input);
  });
}

export async function evidenceText(path, text, append = false) {
  await mkdir(dirname(path), { recursive: true });
  await (append ? appendFile : writeFile)(path, redactText(text));
}
