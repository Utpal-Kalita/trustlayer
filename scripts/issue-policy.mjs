// Re-issue the demo policy with a fresh 2-hour expiry window (PRD section 15).
// Run before demos/tests: node scripts/issue-policy.mjs
// node scripts/issue-policy.mjs --bump also increments the policy version.
// Bumping the version is the explicit owner re-authorization path: it derives
// new authorization identities, so an identical payment that was already
// consumed can be authorized again - deliberately, never silently.
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync('policies/default.json', 'utf8'));
p.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
if (process.argv.includes('--bump')) p.version = (p.version ?? 0) + 1;
fs.writeFileSync('policies/default.json', JSON.stringify(p, null, 2) + '\n');
console.log('policy re-issued, version =', p.version, 'expiresAt =', p.expiresAt);

// Owner re-issue semantics: a plain re-issue (same version) only extends the
// expiry window - executed history, spend counters and consumed nonces all
// carry over, because the spend ledger is namespaced by (cluster, policy
// version). --bump is the explicit owner re-authorization: the new version
// derives new authorization identities AND starts a fresh budget namespace;
// the old version's history remains in data/audit.log, never deleted.
