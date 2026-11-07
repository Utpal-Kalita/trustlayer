// Re-issue the demo policy with a fresh 2-hour expiry window (PRD section 15).
// Run before demos/tests: node scripts/issue-policy.mjs
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync('policies/default.json', 'utf8'));
p.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
fs.writeFileSync('policies/default.json', JSON.stringify(p, null, 2) + '\n');
console.log('policy re-issued, expiresAt =', p.expiresAt);
