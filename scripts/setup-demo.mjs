// Sets up the PRD section 15 demo against a running TrustLayer API:
//   - creates the Squads 2-of-2 multisig + vault if this machine has none (devnet)
//   - registers "Research Agent" on the vault with the demo policy
//   - saves the agent's key to data/demo-agent.json (gitignored) for scripts/demo-agent.mjs
// Run: TRUSTLAYER_API_KEY=... node scripts/setup-demo.mjs   (API must be running)
import fs from 'node:fs';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { loadKeys, loadState, ensureFunded, ensureMultisig } from '../src/onchain.js';

const API = process.env.TRUSTLAYER_API || 'http://localhost:8787';
const KEY = process.env.TRUSTLAYER_API_KEY;
if (!KEY) { console.error('set TRUSTLAYER_API_KEY (same value as the API server)'); process.exit(1); }
const keys = loadKeys();
const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');

let state = loadState();
if (!state.vaultPda || process.argv.includes('--new-multisig')) {
  if (process.argv.includes('--new-multisig')) state = {};
  await ensureFunded(conn, keys);
  state = await ensureMultisig(conn, keys, state);
}
const vault = new PublicKey(state.vaultPda);
const bal = await conn.getBalance(vault);
console.log(`Squads multisig ${state.multisigPda}\nvault ${state.vaultPda} balance ${bal / LAMPORTS_PER_SOL} SOL`);
if (bal < 0.12 * LAMPORTS_PER_SOL) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: keys.owner.publicKey, toPubkey: vault, lamports: 0.15 * LAMPORTS_PER_SOL })), [keys.owner]);
  console.log('owner funded the vault with 0.15 SOL:', sig);
}

const vendorA = keys.env.VENDOR_A_PUBKEY;
const r = await fetch(`${API}/api/agents`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-trustlayer-key': KEY },
  body: JSON.stringify({
    name: 'Research Agent', walletAddress: state.vaultPda,
    policy: { maxTransactionSol: 0.05, spendingLimitSol: 0.1, approvedRecipients: [{ label: 'Vendor A', address: vendorA }], allowedActions: ['sol_transfer'], expiresInHours: 2 },
  }),
});
const out = await r.json();
if (!r.ok) { console.error(out); process.exit(1); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/demo-agent.json', JSON.stringify({ agentId: out.agent.id, apiKey: out.apiKey, vendorA, attacker: keys.env.ATTACKER_PUBKEY }, null, 2));
console.log(`registered "${out.agent.name}" (${out.agent.id}); key saved to data/demo-agent.json`);
