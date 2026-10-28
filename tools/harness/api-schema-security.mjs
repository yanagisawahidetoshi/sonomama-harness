// Security Impact the Harness derives from the existing contract and the proposal. The provider's securityImpact is only a declaration:
// it must cover every derived item, and the required number of approvers never depends on it alone.
// Breaking / non-breaking candidates are reported by the Quality Judge separately; a security downgrade is often not breaking for clients.
export const authNImpact = Object.freeze(['APIAuthentication', 'AuthN']), authZImpact = Object.freeze(['APIAuthorization', 'AuthZ']), piiImpact = Object.freeze(['PII']);
const label = endpoint => `${endpoint.method} ${endpoint.path}`;
const sameRoles = (a, b) => a.length === b.length && a.every(role => b.includes(role));
const conditioned = authz => Boolean(authz) && (authz.roles.length > 0 || Boolean(authz.rule?.trim()));

export function deriveSecurityImpact(proposal, existing = null) {
  const derived = [];
  // One item per category group; every reason is kept so the reviewer sees each endpoint that caused it.
  const need = (categories, reason) => {
    const item = derived.find(entry => entry.categories === categories);
    if (item) item.reason += ` / ${reason}`;
    else derived.push({ categories, reason });
  };
  const before = new Map((existing?.endpoints ?? []).map(e => [label(e), e]));
  for (const endpoint of proposal.endpoints) {
    const target = label(endpoint), old = before.get(target);
    const jwt = endpoint.authN === 'bearer-jwt', authz = jwt ? endpoint.authZ : null;
    if (endpoint.change === 'remove') {
      if (old?.authenticated) need(authNImpact, `認証・認可付きのendpointを削除: ${target}`);
      if (old?.authenticated && conditioned(old.authz)) need(authZImpact, `認証・認可付きのendpointを削除: ${target}`);
      continue;
    }
    if (jwt) need(authNImpact, `Bearer JWT必須のendpoint: ${target}`);
    if (conditioned(authz)) need(authZImpact, `Rails側の認可条件: ${target}`);
    if (endpoint.change !== 'modify' || !old) continue;
    if (old.authenticated && !jwt) need(authNImpact, `認証必須のendpointを公開へ変更: ${target}`);
    if (conditioned(old.authz) && (!conditioned(authz) || !sameRoles(old.authz.roles, authz.roles) || (old.authz.rule ?? null) !== (authz.rule ?? null))) {
      need(authZImpact, `認可条件を削除・緩和: ${target}`);
    }
  }
  if (proposal.endpoints.some(e => e.change !== 'remove' && e.pii) || proposal.components.some(c => c.pii)) need(piiImpact, 'PIIを扱う');
  return derived;
}
// Two different humans whenever the Harness derives an impact; a declaration the Harness does not derive can only raise the count.
export const requiredApprovals = (proposal, existing = null) => deriveSecurityImpact(proposal, existing).length || proposal.securityImpact.length ? 2 : 1;
