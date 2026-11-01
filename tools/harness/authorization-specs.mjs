import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecuritySpecs, inspectRspec } from './security-specs.mjs';
// rails-authz-test verifier, static step: the API authorization specs exist and none of their examples is skipped or focused.
// Running them on the local test database is a separate command in harness.json. Which role may do what is decided in
// docs/product and ADRs and written into these specs by the SBI that implements it; the Harness does not decide it.
// The other spec directories of Security Verifiers share this check through security-specs.mjs (#165).
export const inspectAuthorizationSpec = inspectRspec;

export function checkAuthorizationSpecs({ root }) {
  return checkSecuritySpecs({ root, id: 'rails-authz-test' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkAuthorizationSpecs({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
  console.log(`Authorization specs (${result.specs.length} specs, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
