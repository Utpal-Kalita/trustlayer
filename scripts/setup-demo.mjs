// Registers the PRD section 15 "Research Agent" against a running local TrustLayer API.
// Reuses the verified devnet multisig in data/state.json. It never creates a
// multisig, never moves funds and never requests airdrops. Fund the vault yourself
// if it runs low (see docs/DEVNET-FUNDING.md).
// Run: TRUSTLAYER_API_KEY=... node scripts/setup-demo.mjs   (API must be running)
import fs from 'node:fs';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { loadState, loadPublicAddresses } from '../src/onchain.js';

const API = process.env.TRUSTLAYER_API || 'http://localhost:8787';
const KEY = process.env.TRUSTLAYER_API_KEY;
if (!KEY) { console.error('set TRUSTLAYER_API_KEY (same value as the API server)'); process.exit(1); }
const state = loadState();
if (!state.vaultPda) { console.error('data/state.json has no multisig'); process.exit(1); }
const { vendorA, attacker } = loadPublicAddresses();
const VENDOR_A = vendorA || 'HnJmp1w4iSgoHiKjDckNSc9qkXSuREu9Ch2NWJabPC3Z';
const ATTACKER = attacker || '7GC8LGCn9vJ6jDQ1jQQ8ctyyRRcnSRWW2HvVDEsnKScM';

const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
const bal = await conn.getBalance(new PublicKey(state.vaultPda)).catch(() => null);
console.log(`multisig ${state.multisigPda}\nvault ${state.vaultPda} balance ${bal == null ? 'unknown' : bal / LAMPORTS_PER_SOL + ' SOL'}`);
if (bal != null && bal < 0.02 * LAMPORTS_PER_SOL) console.warn('warning: vault is low; simulation will block payments until the owner funds it');

const r = await fetch(`${API}/api/agents`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-trustlayer-key': KEY },
  body: JSON.stringify({
    name: 'Research Agent', walletAddress: state.vaultPda,
    policy: { maxTransactionSol: 0.05, spendingLimitSol: 0.1, approvedRecipients: [{ label: 'Vendor A', address: VENDOR_A }], allowedActions: ['sol_transfer'], expiresInHours: 2 },
  }),
});
const out = await r.json();
if (!r.ok) { console.error(out); process.exit(1); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/demo-agent.json', JSON.stringify({ agentId: out.agent.id, apiKey: out.apiKey, vendorA: VENDOR_A, attacker: ATTACKER }, null, 2));
console.log(`registered "${out.agent.name}" (${out.agent.id}); key saved to data/demo-agent.json`);
