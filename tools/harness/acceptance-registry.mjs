import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceRegistrationSchema, configSchema } from './schemas.mjs';
// harness.json holds the shared Verifier Registry only. The Trusted Acceptance of an SBI Issue lives in .harness/acceptance/sbi-<N>.json,
// so a run and the CI rebuild of its SBI read that Issue's file alone and a registration for another Issue changes nothing for them.
export const acceptancePath = number => `.harness/acceptance/sbi-${number}.json`;

export async function readAcceptance(root, number) {
  const path = acceptancePath(number);
  let text;
  try { text = await readFile(join(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let parsed;
  try { parsed = acceptanceRegistrationSchema.safeParse(JSON.parse(text)); } catch (error) { throw new Error(`${path}: ${error.message}`); }
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  if (parsed.data.sbiIssue !== number) throw new Error(`${path} registers SBI Issue #${parsed.data.sbiIssue}, not #${number}`);
  return parsed.data;
}

// The registrations become acceptance verifiers carrying sbiIssue, which is what sbiFromIssue and the verifier selection read.
export async function withAcceptance(root, config, numbers) {
  const verifiers = [...config.verifiers];
  for (const number of [...new Set(numbers)]) {
    for (const v of (await readAcceptance(root, number))?.verifiers ?? []) {
      if (v.id === 'sample-bdd' || verifiers.some(other => other.id === v.id)) throw new Error(`${acceptancePath(number)}: verifier ID ${v.id} is already registered`);
      verifiers.push({ id: v.id, trust: 'acceptance', trustedScript: v.trustedScript, directory: '.', planned: v.planned, commands: [], acceptanceIds: v.acceptanceIds, sbiIssue: number });
    }
  }
  return configSchema.parse({ ...config, verifiers });
}
