// Plays the AI agent in the PRD section 15 demo. It only holds its own
// x-agent-key: it can propose, it cannot approve, change policy or move funds.
// Run after setup-demo.mjs:  node scripts/demo-agent.mjs [--execute]
//   --execute  send proposals to /api/transactions/execute: an approved one becomes a
//              Squads proposal with the agent's vote 1 of 2. Funds move only after the
//              owner runs the printed gatekeeper command (vote 2 of 2).
import fs from 'node:fs';

const API = process.env.TRUSTLAYER_API || 'http://localhost:8787';
const { apiKey, vendorA, attacker } = JSON.parse(fs.readFileSync('data/demo-agent.json', 'utf8'));
const endpoint = process.argv.includes('--execute') ? 'execute' : 'evaluate';

const scenarios = [
  ['Test 1: legitimate payment', { recipient: vendorA, amountSol: 0.01, memo: 'research report #1' }],
  ['Test 2: spending violation', { recipient: vendorA, amountSol: 0.5 }],
  ['Test 3: prompt-injected payment to unknown wallet', { recipient: attacker, amountSol: 0.01 }],
];
for (const [name, body] of scenarios) {
  const r = await fetch(`${API}/api/transactions/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-key': apiKey }, body: JSON.stringify(body) });
  const d = await r.json();
  console.log(`\n${name}: ${body.amountSol} SOL -> ${body.recipient.slice(0, 4)}…${body.recipient.slice(-4)}`);
  if (!r.ok) { console.log('  error:', d.error); continue; }
  console.log(`  ${d.decision}  ${d.explanation}`);
  for (const c of d.checks || []) console.log(`    ${c.pass === true ? '✓' : c.pass === false ? '✗' : '–'} ${c.label}: ${c.reason}`);
  if (d.transactionIndex) console.log(`  Squads proposal #${d.transactionIndex}: agent approved 1 of 2, funds not moved.\n  owner-side gatekeeper, verify then approve:\n    ${d.gatekeeperCommand}\n    ${d.gatekeeperCommand.replace(' check ', ' approve ')}`);
}
