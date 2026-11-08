// Ask the hosted TrustLayer agent (Cloudflare worker) to propose a payment.
// The worker re-runs the policy, then its AGENT key creates the Squads vault
// transaction + proposal and casts approval 1 of 2. Funds do NOT move.
// The owner then verifies and approves 2 of 2 with scripts/gatekeeper-execute.mjs.
//
// TRUSTLAYER_API_KEY is read from the environment of this terminal only.
// It never goes into browser code.
//
// Usage: TRUSTLAYER_API_KEY=... node scripts/hosted-propose.mjs <destination> <amountSol> [authId]
const WORKER = process.env.TRUSTLAYER_WORKER || 'https://trustlayer-api-cf.adzeo2.workers.dev';
const [destination, amount, authArg] = process.argv.slice(2);
const key = process.env.TRUSTLAYER_API_KEY;
if (!destination || !amount) { console.error('usage: node scripts/hosted-propose.mjs <destination> <amountSol> [authId]'); process.exit(1); }
if (!key) { console.error('set TRUSTLAYER_API_KEY in this terminal (never in browser code)'); process.exit(1); }
const authId = authArg || `cli-${Date.now().toString(36)}`;

const dry = await (await fetch(`${WORKER}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination, amountSol: Number(amount) }) })).json();
console.log(`dry run: ${dry.allow ? 'APPROVED' : 'BLOCKED'}${dry.allow ? '' : ' - ' + (dry.reasons || []).join('; ')}`);
if (!dry.allow) process.exit(2);

const r = await fetch(`${WORKER}/api/execute`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-trustlayer-key': key }, body: JSON.stringify({ destination, amountSol: Number(amount), authId }) });
const d = await r.json().catch(() => ({}));
if (!r.ok || !d.ok) { console.error(`worker refused (${r.status}):`, d.reasons || d.error || d); process.exit(3); }
const lamports = Math.round(Number(amount) * 1e9);
console.log(`proposed: Squads #${d.transactionIndex}, agent approved 1 of 2, funds not moved`);
for (const [k, s] of Object.entries(d.sigs || {})) console.log(`  ${k}: https://explorer.solana.com/tx/${s}?cluster=devnet`);
console.log(`\nowner-side gatekeeper (where GATEKEEPER_SECRET lives):`);
console.log(`  node scripts/gatekeeper-execute.mjs ${d.transactionIndex} check   --expect ${destination} ${lamports} --expect-memo ${d.memo}`);
console.log(`  node scripts/gatekeeper-execute.mjs ${d.transactionIndex} approve --expect ${destination} ${lamports} --expect-memo ${d.memo}`);
