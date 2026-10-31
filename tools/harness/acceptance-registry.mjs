import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceRegistrationSchema, configSchema, generatedRegistrationSchema } from './schemas.mjs';
// harness.json holds the shared Verifier Registry only. The Trusted Acceptance of an SBI Issue lives in .harness/acceptance/sbi-<N>.json,
// so a run and the CI rebuild of its SBI read that Issue's file alone and a registration for another Issue changes nothing for them.
export const acceptancePath = number => `.harness/acceptance/sbi-${number}.json`;
// The one acceptance verifier of a spec-approved SBI whose Trusted Acceptance is generated in the run (#147).
export const generatedVerifierId = number => `generated-acceptance-sbi-${number}`;

export async function readAcceptance(root, number) {
  const path = acceptancePath(number);
  let text;
  try { text = await readFile(join(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let parsed;
  // Version 2 is generated in a run from an approved spec (#147); its tests run through the generated-acceptance flow, not trustedScript.
  try { const value = JSON.parse(text); parsed = (value?.version === 2 ? generatedRegistrationSchema : acceptanceRegistrationSchema).safeParse(value); } catch (error) { throw new Error(`${path}: ${error.message}`); }
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  if (parsed.data.sbiIssue !== number) throw new Error(`${path} registers SBI Issue #${parsed.data.sbiIssue}, not #${number}`);
  return parsed.data;
}

// The registrations become acceptance verifiers carrying sbiIssue, which is what sbiFromIssue and the verifier selection read.
// Two trees (ADR-0008): a hand-written registration (version 1) runs a script of the trusted root, so only the root's counts; a generated one
// (version 2) comes with the PR in the workspace and is checked against the spec digest.
export async function withAcceptance(root, config, numbers, workspace = root) {
  const verifiers = [...config.verifiers];
  for (const number of [...new Set(numbers)]) {
    const trusted = await readAcceptance(root, number), proposed = workspace === root ? trusted : await readAcceptance(workspace, number);
    const registration = proposed?.version === 2 ? proposed : trusted?.version === 1 ? trusted : null;
    if (registration?.version === 2) {
      const id = generatedVerifierId(number);
      if (verifiers.some(other => other.id === id)) throw new Error(`${acceptancePath(number)}: verifier ID ${id} is already registered`);
      verifiers.push({ id, trust: 'acceptance', generated: true, directory: '.', planned: ['Generated Trusted Acceptance (Rails request spec)'], commands: [],
        acceptanceIds: [...new Set(registration.mapping.flatMap(m => m.acceptanceIds))].sort(), sbiIssue: number });
    }
    for (const v of registration?.version === 1 ? registration.verifiers : []) {
      if (v.id === 'sample-bdd' || verifiers.some(other => other.id === v.id)) throw new Error(`${acceptancePath(number)}: verifier ID ${v.id} is already registered`);
      verifiers.push({ id: v.id, trust: 'acceptance', trustedScript: v.trustedScript, directory: '.', planned: v.planned, commands: [], acceptanceIds: v.acceptanceIds, sbiIssue: number });
    }
  }
  return configSchema.parse({ ...config, verifiers });
}
