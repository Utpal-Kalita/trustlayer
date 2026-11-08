// Authorization service: proposal -> inspect -> simulate -> policy -> (reserve -> Squads execute).
//
// Both /api/transactions/evaluate and /api/transactions/execute run the FULL
// pipeline from the raw proposal. Execute never trusts a client-supplied
// `approved` flag or an earlier evaluation id (PRD section 11).
import { inspectProposal, InspectionError } from './inspect/inspector.js';
import { simulateInspection, connection, SIMULATION_MODE } from './inspect/simulate.js';
import { evaluatePolicy, authorizationId, fmtSol } from './policy/checks.js';
import { loadAgentKey, loadState, proposeSquadsTransfer, proposalStatus } from './onchain.js';

// Same memo namespace as the Cloudflare worker, so its chain-derived budget
// counts spend proposed here too (conservative: never under-counts).
const MEMO_POLICY_ID = process.env.TRUSTLAYER_MEMO_POLICY_ID || 'default-hackathon-policy';

// Agent-side proposing needs only the agent key and the verified multisig.
// The gatekeeper and owner keys are never loaded by this server.
export function executionStatus(agent) {
  const state = loadState();
  if (process.env.TRUSTLAYER_READ_ONLY === '1') return { enabled: false, reason: 'proposing is disabled on this read-only host' };
  let key = null;
  try { key = loadAgentKey(); } catch { /* malformed */ }
  if (!key) return { enabled: false, reason: 'no AGENT_SECRET configured on this server' };
  if (!state.vaultPda) return { enabled: false, reason: 'no multisig in data/state.json' };
  if (agent && agent.wallet_address !== state.vaultPda)
    return { enabled: false, reason: `this server proposes for vault ${state.vaultPda}; agent wallet ${agent.wallet_address} is not that vault` };
  return { enabled: true, agentKey: key, state, vault: state.vaultPda, multisig: state.multisigPda };
}

export async function authorize(store, agent, proposal, { execute = false, source = 'agent-api', simulate = simulateInspection } = {}) {
  const nonce = proposal.nonce != null ? String(proposal.nonce).slice(0, 80) : null;

  // 1. Inspect (decode every instruction).
  let inspection;
  try {
    inspection = inspectProposal(proposal, { senderWallet: agent.wallet_address });
  } catch (e) {
    if (!(e instanceof InspectionError)) throw e;
    const t = store.insertTransaction({
      agent_id: agent.id, policy_id: null, policy_version: null, mode: execute ? 'execute' : 'evaluate', source,
      recipient: proposal.recipient ?? null, recipients: [], amount_lamports: 0, transaction_type: 'invalid',
      status: 'rejected', rejection_reason: e.message, nonce,
      checks: [{ id: 'inspection', label: 'Transaction decoding', pass: false, reason: e.message }],
      proposal: redact(proposal),
    });
    const ev = store.insertSecurityEvent({ agentId: agent.id, eventType: 'unsupported_transaction', description: e.message, transactionId: t.id });
    return { transaction: t, decision: 'BLOCKED', allow: false, reasons: [e.message], checks: t.checks, events: [ev] };
  }

  // 2. Simulate against live Solana state (async, before the atomic section).
  const inspectable = inspection.unsupported.length === 0 && inspection.senders.every(s => s === agent.wallet_address);
  const simulation = inspectable ? await simulate(inspection) : null;

  // 3. Atomic section: no `await` from reading spend to writing the reservation.
  const policy = store.policyForAgent(agent.id);
  const authId = policy ? authorizationId(policy, inspection, nonce) : null;
  const result = evaluatePolicy({
    agent: store.getAgent(agent.id), // re-read: status may have changed during simulation
    policy, inspection, simulation, nonce,
    spentLamports: policy ? store.spentLamports(policy.id) : 0,
    authState: policy && nonce != null ? store.authState(policy.id, authId) : 'free',
  });
  const status = !result.allow ? 'rejected' : execute ? 'reserved' : 'approved';
  const t = store.insertTransaction({
    agent_id: agent.id, policy_id: policy?.id ?? null, policy_version: policy?.version ?? null,
    mode: execute ? 'execute' : 'evaluate', source,
    recipient: inspection.recipients[0] ?? null, recipients: inspection.recipients,
    sender: inspection.sender, amount_lamports: inspection.lamports,
    transaction_type: inspection.actions.join(',') || 'none', programs: inspection.programs,
    instructions: inspection.instructions, status, rejection_reason: result.allow ? null : result.reasons.join(' '),
    explanation: result.explanation, checks: result.checks, simulation, auth_id: nonce != null ? authId : null, nonce,
    proposal: redact(proposal),
  });
  const events = result.events.map(e => store.insertSecurityEvent({ agentId: agent.id, ...e, transactionId: t.id }));

  if (!result.allow || !execute) return { transaction: t, ...pick(result), events };

  // 4. Agent side of Squads: vault transaction + proposal + approval 1 of 2.
  //    Funds do not move. The owner-side gatekeeper verifies the on-chain
  //    transaction and casts vote 2 of 2 (scripts/gatekeeper-execute.mjs).
  //    The reservation stays held until the chain shows execution or rejection.
  const ex = executionStatus(agent);
  if (!ex.enabled) {
    store.updateTransaction(t.id, { status: 'failed', rejection_reason: ex.reason });
    return { transaction: store.updateTransaction(t.id, {}), ...pick(result), allow: false, decision: 'NOT PROPOSED', reasons: [ex.reason], events };
  }
  try {
    const transfers = inspection.instructions.filter(i => i.action === 'sol_transfer').map(i => ({ to: i.to, lamports: i.lamports }));
    const memo = `trustlayer:${MEMO_POLICY_ID}:v${policy.version}:${t.id.replace(/-/g, '').slice(0, 24)}`;
    const out = await proposeSquadsTransfer(connection(), ex.agentKey, ex.state, transfers, memo);
    const gatekeeperCommand = `node scripts/gatekeeper-execute.mjs ${out.transactionIndex} check` +
      (transfers.length === 1 ? ` --expect ${transfers[0].to} ${transfers[0].lamports}` : '') + ` --expect-memo ${memo}`;
    const done = store.updateTransaction(t.id, { status: 'proposed', squads: { ...out, gatekeeperCommand } });
    return { transaction: done, ...pick(result), decision: 'PROPOSED', events, transactionIndex: out.transactionIndex, gatekeeperCommand,
      note: 'Agent approved 1 of 2. Funds have not moved. The owner-side gatekeeper must verify and approve 2 of 2.' };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    const failed = store.updateTransaction(t.id, { status: 'failed', rejection_reason: `Proposal failed after approval: ${msg}` });
    events.push(store.insertSecurityEvent({ agentId: agent.id, eventType: 'execution_failed', description: msg, transactionId: t.id }));
    return { transaction: failed, ...pick(result), decision: 'FAILED', allow: false, reasons: [msg], events };
  }
}

// Reconcile proposals with the chain: executed -> executed (+signature),
// rejected/cancelled -> failed (reservation released). Throttled.
let lastSync = 0;
export async function syncProposals(store, { force = false } = {}) {
  if (!force && Date.now() - lastSync < 10_000) return;
  lastSync = Date.now();
  const pending = store.db.transactions.filter(t => t.status === 'proposed' && t.squads?.transactionIndex);
  if (!pending.length) return;
  const state = loadState();
  for (const t of pending) {
    try {
      const st = await proposalStatus(connection(), state, t.squads.transactionIndex);
      if (st.status === 'executed') store.updateTransaction(t.id, { status: 'executed', transaction_signature: st.signature, squads: { ...t.squads, approvals: st.approvals } });
      else if (st.status === 'rejected' || st.status === 'cancelled') {
        store.updateTransaction(t.id, { status: 'failed', rejection_reason: `Gatekeeper ${st.status} the proposal on chain; reservation released.` });
        store.insertSecurityEvent({ agentId: t.agent_id, eventType: 'proposal_rejected', description: `Squads proposal #${t.squads.transactionIndex} was ${st.status} on chain.`, transactionId: t.id });
      }
    } catch { /* RPC down: keep the reservation held (fail closed) */ }
  }
}

function pick(r) { return { decision: r.decision, allow: r.allow, reasons: r.reasons, explanation: r.explanation, checks: r.checks }; }

function redact(p) {
  const out = {};
  for (const k of ['recipient', 'destination', 'amountSol', 'action', 'nonce', 'memo']) if (p[k] !== undefined) out[k] = p[k];
  if (p.transaction) out.transaction = String(p.transaction).slice(0, 2048);
  return out;
}

// Dashboard overview (PRD Module 6 A).
export function overview(store, userId) {
  const agents = store.listAgents(userId);
  const txs = store.listTransactions({ userId, limit: 100000 });
  return {
    agents: agents.length,
    activeAgents: agents.filter(a => a.status === 'active').length,
    proposed: txs.length,
    approved: txs.filter(t => ['approved', 'executed', 'reserved', 'proposed'].includes(t.status)).length,
    awaitingGatekeeper: txs.filter(t => t.status === 'proposed').length,
    executed: txs.filter(t => t.status === 'executed').length,
    rejected: txs.filter(t => t.status === 'rejected').length,
    authorizedLamports: txs.filter(t => t.status === 'executed').reduce((s, t) => s + t.amount_lamports, 0),
    securityEvents: store.listSecurityEvents({ userId, limit: 100000 }).length,
    simulationMode: SIMULATION_MODE,
  };
}

export { fmtSol };
