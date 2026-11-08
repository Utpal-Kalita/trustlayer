// AI agent demo driver (PRD Module 7): turns a natural-language task into a
// TrustLayer-gated Squads execution.
//
//   node scripts/ai-agent.mjs "Pay Vendor A 0.01 SOL for the research summary"
//   node scripts/ai-agent.mjs "Pay Vendor A 0.01 SOL" --execute
//
// Flow: task -> POST /api/agent (LLM interprets; deterministic policy engine
// decides; LLM explains) -> with --execute and an allowed verdict, the key-gated
// /api/execute creates the Squads proposal (agent signs 1-of-2). Execution still
// requires the owner-side gatekeeper (scripts/gatekeeper-execute.mjs <txIndex>).
// API_KEY and GATEKEEPER_SECRET stay local; the LLM can never approve or execute.
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}
const API = process.env.TRUSTLAYER_API || 'https://trustlayer-api-cf.adzeo2.workers.dev';
const task = process.argv[2];
const doExecute = process.argv.includes('--execute');
if (!task) { console.error('usage: node scripts/ai-agent.mjs "<task>" [--execute]'); process.exit(1); }

const r = await fetch(API + '/api/agent', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-trustlayer-key': env.TRUSTLAYER_API_KEY }, body: JSON.stringify({ task }),
});
const d = await r.json();
console.log('model:', d.model || '-');
console.log('task:', task);
if (!d.ok) { console.log('interpret failed:', d.error); process.exit(2); }
console.log('proposal:', d.proposal.amountSol, 'SOL ->', d.proposal.destination);
console.log('verdict:', d.verdict.allow ? 'ALLOWED' : 'BLOCKED');
for (const reason of d.verdict.reasons) console.log('  -', reason);
if (d.explanation) console.log('AI explanation:', d.explanation);
if (!d.verdict.allow) { console.log('The deterministic policy engine blocked this. No signature exists; nothing can execute.'); process.exit(0); }
if (!doExecute) { console.log('dry run - rerun with --execute to create the Squads proposal (owner key-gated).'); process.exit(0); }

const authId = 'ai-' + Date.now();
const er = await fetch(API + '/api/execute', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-trustlayer-key': env.TRUSTLAYER_API_KEY },
  body: JSON.stringify({ destination: d.proposal.destination, amountSol: d.proposal.amountSol, authId }),
});
const e = await er.json();
if (!e.ok && e.status !== 'proposed-awaiting-gatekeeper') { console.log('execute rejected:', JSON.stringify(e)); process.exit(3); }
console.log('Squads proposal created (agent approved 1-of-2). Funds have NOT moved.');
console.log('txIndex:', e.transactionIndex, 'authId:', authId, 'memo:', e.memo);
console.log('Next (owner side): node scripts/gatekeeper-execute.mjs ' + e.transactionIndex + ' approve --expect ' + d.proposal.destination + ' ' + Math.round(d.proposal.amountSol * 1e9) + ' --expect-memo ' + e.memo);
