// End-to-end API tests for the PRD success criteria (section 5) and security
// requirements (section 12). Offline: simulation is stubbed, no chain, no keys.
// Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram, Transaction, PublicKey } from '@solana/web3.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlayer-test-'));
process.env.TRUSTLAYER_DB = path.join(tmp, 'db.json');
process.env.TRUSTLAYER_SIMULATION = 'off';
process.env.TRUSTLAYER_API_KEY = 'test-admin-key';
process.env.TRUSTLAYER_READ_ONLY = '1'; // execution disabled: proves execute never fakes success
const { server, store } = await import('../src/api/server.js');
const { authorize } = await import('../src/service.js');
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) { failures++; if (extra !== undefined) console.log('     ', JSON.stringify(extra).slice(0, 400)); } };
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const owner = { 'x-trustlayer-key': 'test-admin-key' };
const addr = () => Keypair.generate().publicKey.toBase58();
const VAULT = addr(), VENDOR_A = addr(), VENDOR_B = addr(), UNKNOWN = addr();

// --- Module 1: agent registration
let r = await call('POST', '/api/agents', { name: 'Research Agent', walletAddress: VAULT });
ok('unauthenticated registration refused', r.status === 401);
r = await call('POST', '/api/agents', {
  name: 'Research Agent', walletAddress: VAULT,
  policy: { maxTransactionSol: 0.05, spendingLimitSol: 0.1, approvedRecipients: [{ label: 'Vendor A', address: VENDOR_A }], allowedActions: ['sol_transfer'], expiresInHours: 2 },
}, owner);
ok('agent registered with a unique id and a one-time key', r.status === 201 && r.body.agent.id && r.body.apiKey?.startsWith('tla_'), r.body);
const agent = r.body.agent, agentKey = { 'x-agent-key': r.body.apiKey };
ok('agent key hash is never returned', !JSON.stringify(r.body.agent).includes('api_key_hash'));
r = await call('GET', '/api/agents', null, owner);
ok('agent listed with its policy', r.body.agents.length === 1 && r.body.agents[0].policy?.max_transaction_lamports === 50_000_000);
ok('agent persisted to the database', JSON.parse(fs.readFileSync(process.env.TRUSTLAYER_DB, 'utf8')).agents.length === 1);

// --- PRD section 15 demo + section 5 success criteria
const ev = (body, h = agentKey) => call('POST', '/api/transactions/evaluate', body, h);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01 });
ok('Test 1: valid payment to Vendor A is APPROVED', r.body.decision === 'APPROVED' && r.body.checks.every(c => c.pass), r.body);
r = await ev({ recipient: VENDOR_A, amountSol: 0.5 });
ok('Test 2: 0.5 SOL is BLOCKED (exceeds limit)', r.body.decision === 'BLOCKED' && /exceeds the maximum authorized limit/.test(r.body.explanation), r.body);
r = await ev({ recipient: UNKNOWN, amountSol: 0.01 });
ok('Test 3: unknown recipient is BLOCKED with the PRD reason', r.body.decision === 'BLOCKED' && /not authorized by the agent's permission policy/.test(r.body.explanation), r.body);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01, action: 'spl_transfer' });
ok('disallowed action is BLOCKED', r.body.decision === 'BLOCKED' && r.body.checks.find(c => c.id === 'action')?.pass === false, r.body);

// serialized transaction: every instruction inspected, not just the first
const tx = new Transaction({ feePayer: new PublicKey(VAULT), recentBlockhash: '11111111111111111111111111111111' });
tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(VAULT), toPubkey: new PublicKey(VENDOR_A), lamports: 1_000_000 }));
tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(VAULT), toPubkey: new PublicKey(UNKNOWN), lamports: 1_000_000 }));
r = await ev({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
ok('hidden second transfer to unknown wallet is BLOCKED', r.body.decision === 'BLOCKED' && r.body.transaction.recipients.length === 2, r.body);
const tx2 = new Transaction({ feePayer: new PublicKey(VAULT), recentBlockhash: '11111111111111111111111111111111' });
tx2.add(SystemProgram.transfer({ fromPubkey: new PublicKey(VAULT), toPubkey: new PublicKey(VENDOR_A), lamports: 1_000_000 }));
tx2.add(SystemProgram.assign({ accountPubkey: new PublicKey(VAULT), programId: new PublicKey(UNKNOWN) }));
r = await ev({ transaction: tx2.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
ok('unsupported instruction (System assign) is BLOCKED', r.body.decision === 'BLOCKED' && r.body.checks.find(c => c.id === 'inspection')?.pass === false, r.body);
const tx3 = new Transaction({ feePayer: new PublicKey(UNKNOWN), recentBlockhash: '11111111111111111111111111111111' });
tx3.add(SystemProgram.transfer({ fromPubkey: new PublicKey(UNKNOWN), toPubkey: new PublicKey(VENDOR_A), lamports: 1_000_000 }));
r = await ev({ transaction: tx3.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
ok('transfer from a wallet other than the agent vault is BLOCKED', r.body.decision === 'BLOCKED' && r.body.checks.find(c => c.id === 'sender')?.pass === false, r.body);
r = await ev({ transaction: 'bm90IGEgdHJhbnNhY3Rpb24=' });
ok('garbage transaction bytes are BLOCKED', r.body.decision === 'BLOCKED');

// --- Execute boundary
r = await call('POST', '/api/transactions/execute', { recipient: UNKNOWN, amountSol: 0.01, approved: true }, agentKey);
ok('execute ignores client approved:true and re-evaluates', r.body.decision === 'BLOCKED' && !r.body.transaction.transaction_signature, r.body);
r = await call('POST', '/api/transactions/execute', { recipient: VENDOR_A, amountSol: 0.01 }, agentKey);
ok('execute without a signing setup never reports success', r.body.allow === false && r.body.transaction.status === 'failed' && !r.body.transaction.transaction_signature, r.body);
ok('failed execution releases its reservation', store.spentLamports(agent.policy.id) === 0);

// --- Spending limit is cumulative and atomic
const pol = store.policyForAgent(agent.id);
store.insertTransaction({ agent_id: agent.id, policy_id: pol.id, amount_lamports: 90_000_000, status: 'executed', recipient: VENDOR_A });
r = await ev({ recipient: VENDOR_A, amountSol: 0.02 });
ok('cumulative spending beyond 0.1 SOL is BLOCKED', r.body.decision === 'BLOCKED' && r.body.checks.find(c => c.id === 'spending_limit')?.pass === false, r.body);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01 });
ok('exactly at the total cap is APPROVED (integer lamports)', r.body.decision === 'APPROVED', r.body);
// concurrent proposals: each reservation is visible to the next in the same tick
const fakeExec = { execute: false };
const results = await Promise.all([1, 2, 3].map(() => authorize(store, store.getAgent(agent.id), { recipient: VENDOR_A, amountSol: 0.01 }, { ...fakeExec, simulate: async () => ({ ok: true, ran: false, note: 'stub' }) })));
ok('concurrent evaluations all see the same committed spend', results.every(x => x.allow));

// --- Policy changes take effect immediately (and are versioned)
r = await call('PATCH', `/api/policies/${pol.id}`, { approvedRecipients: [{ label: 'Vendor A', address: VENDOR_A }, { label: 'Vendor B', address: VENDOR_B }], spendingLimitSol: 1 }, owner);
ok('policy update bumps the version', r.body.policy.version === 2, r.body);
r = await ev({ recipient: VENDOR_B, amountSol: 0.01 });
ok('updated policy reflected in the next decision', r.body.decision === 'APPROVED' && r.body.transaction.policy_version === 2, r.body);
r = await call('PATCH', `/api/policies/${pol.id}`, { maxTransactionSol: 5 }, owner);
ok('per-tx limit above total limit refused', r.status === 400);

// --- Expired permission
await call('PATCH', `/api/policies/${pol.id}`, { expiresAt: new Date(Date.now() - 1000).toISOString() }, owner);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01 });
ok('expired permission is BLOCKED', r.body.decision === 'BLOCKED' && /expired/.test(r.body.explanation), r.body);
await call('PATCH', `/api/policies/${pol.id}`, { expiresInHours: 2 }, owner);

// --- Replay (caller nonce)
store.insertTransaction({ agent_id: agent.id, policy_id: pol.id, amount_lamports: 0, status: 'executed', auth_id: (await import('../src/policy/checks.js')).authorizationId(store.getPolicy(pol.id), (await import('../src/inspect/inspector.js')).inspectProposal({ recipient: VENDOR_A, amountSol: 0.01 }, { senderWallet: VAULT }), 'task-42') });
r = await ev({ recipient: VENDOR_A, amountSol: 0.01, nonce: 'task-42' });
ok('reused nonce is BLOCKED as replay', r.body.decision === 'BLOCKED' && r.body.checks.find(c => c.id === 'replay')?.pass === false, r.body);

// --- Failed simulation blocks (fail closed)
const simFail = await authorize(store, store.getAgent(agent.id), { recipient: VENDOR_A, amountSol: 0.01 }, { simulate: async () => ({ ran: true, ok: false, error: '{"InsufficientFundsForRent":{"account_index":0}}' }) });
ok('failed simulation is BLOCKED', !simFail.allow && simFail.checks.find(c => c.id === 'simulation').pass === false);
const simDown = await authorize(store, store.getAgent(agent.id), { recipient: VENDOR_A, amountSol: 0.01 }, { simulate: async () => ({ ran: false, ok: false, error: 'simulation unavailable: RPC down' }) });
ok('unreachable RPC fails closed', !simDown.allow);

// --- Inactive agent
await call('PATCH', `/api/agents/${agent.id}`, { status: 'inactive' }, owner);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01 });
ok('inactive agent cannot get transactions authorized', r.body.decision === 'BLOCKED' && r.body.checks[0].pass === false, r.body);
await call('PATCH', `/api/agents/${agent.id}`, { status: 'active' }, owner);

// --- Agent isolation and key rotation
const other = (await call('POST', '/api/agents', { name: 'Other', walletAddress: addr() }, owner)).body.agent;
r = await ev({ agentId: other.id, recipient: VENDOR_A, amountSol: 0.01 });
ok('an agent key cannot propose for another agent', r.status === 403);
r = await call('POST', '/api/policies', { agentId: agent.id, maxTransactionSol: 1, spendingLimitSol: 1, approvedRecipients: [UNKNOWN] }, agentKey);
ok('an agent cannot change its own policy', r.status === 401);
r = await ev({ agentId: other.id, recipient: VENDOR_A, amountSol: 0.01 }, owner);
ok('agent without a policy is BLOCKED', r.body.decision === 'BLOCKED');
const rot = await call('POST', `/api/agents/${agent.id}/rotate-key`, null, owner);
r = await ev({ recipient: VENDOR_A, amountSol: 0.01 });
ok('revoked agent key stops working', r.status === 401 && rot.body.apiKey);

// --- Module 6: audit, history and security events
r = await call('GET', '/api/transactions', null, owner);
ok('every authorization attempt is recorded', r.body.transactions.length >= 18 && r.body.transactions.every(t => t.status));
ok('every rejection has a reason', r.body.transactions.filter(t => t.status === 'rejected').every(t => t.rejection_reason));
ok('records carry agent, policy version and checks', r.body.transactions.filter(t => t.policy_id && t.mode).every(t => t.agent_id && t.policy_version && t.checks?.length));
r = await call('GET', '/api/security-events', null, owner);
const kinds = new Set(r.body.events.map(e => e.event_type));
ok('security events cover limit, recipient, expiry, action, simulation', ['transaction_limit_violation', 'spending_limit_violation', 'unauthorized_recipient', 'expired_permission', 'disallowed_action', 'failed_simulation', 'inactive_agent'].every(k => kinds.has(k)), [...kinds]);
r = await call('GET', '/api/overview', null, owner);
ok('overview counts proposed / approved / rejected', r.body.proposed >= 18 && r.body.rejected > 0 && r.body.approved > 0 && r.body.agents === 2, r.body);

// --- Wallet sign-in
const { ed25519 } = await import('@noble/curves/ed25519');
const bs58 = (await import('bs58')).default;
const kp = Keypair.generate();
r = await call('POST', '/api/auth/challenge', { wallet: kp.publicKey.toBase58() });
const sig = ed25519.sign(new TextEncoder().encode(r.body.message), kp.secretKey.slice(0, 32));
r = await call('POST', '/api/auth/verify', { wallet: kp.publicKey.toBase58(), signature: bs58.encode(sig) });
ok('wallet signature sign-in issues a session', r.status === 200 && r.body.token);
const me = { authorization: `Bearer ${r.body.token}` };
r = await call('GET', '/api/agents', null, me);
ok('a new owner sees only their own agents', r.body.agents.length === 0);
r = await call('GET', `/api/agents/${agent.id}`, null, me);
ok('another owner\'s agent is not visible', r.status === 404);
r = await call('POST', '/api/auth/verify', { wallet: kp.publicKey.toBase58(), signature: bs58.encode(sig) });
ok('a signed challenge cannot be replayed', r.status === 400);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) FAILED` : '\nall API tests passed');
process.exit(failures ? 1 : 0);
