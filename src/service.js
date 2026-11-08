// Authorization service: proposal -> inspect -> simulate -> policy -> (reserve -> Squads execute).
//
// Both /api/transactions/evaluate and /api/transactions/execute run the FULL
// pipeline from the raw proposal. Execute never trusts a client-supplied
// `approved` flag or an earlier evaluation id (PRD section 11).
import { inspectProposal, InspectionError } from './inspect/inspector.js';
import { simulateInspection, connection, SIMULATION_MODE } from './inspect/simulate.js';
import { evaluatePolicy, authorizationId, fmtSol } from './policy/checks.js';
import { loadKeys, loadState, executeSquadsTransfer } from './onchain.js';

export function executionStatus(agent) {
  let keys = null, state = loadState();
  try { keys = loadKeys(); } catch { /* no keys on this host */ }
  if (process.env.TRUSTLAYER_READ_ONLY === '1') return { enabled: false, reason: 'execution is disabled on this read-only host' };
  if (!keys) return { enabled: false, reason: 'no agent/gatekeeper keys configured (run node scripts/genkeys.mjs)' };
  if (!state.vaultPda) return { enabled: false, reason: 'no Squads multisig yet (run node scripts/setup-demo.mjs)', keys };
  if (agent && agent.wallet_address !== state.vaultPda)
    return { enabled: false, reason: `this server's Squads vault is ${state.vaultPda}; agent wallet ${agent.wallet_address} is not managed here`, keys, state };
  return { enabled: true, keys, state, vault: state.vaultPda, multisig: state.multisigPda };
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

  // 4. Execute through Squads. Any failure releases the reservation.
  const ex = executionStatus(agent);
  if (!ex.enabled) {
    store.updateTransaction(t.id, { status: 'failed', rejection_reason: ex.reason });
    return { transaction: store.updateTransaction(t.id, {}), ...pick(result), allow: false, decision: 'NOT EXECUTED', reasons: [ex.reason], events };
  }
  try {
    const transfers = inspection.instructions.filter(i => i.action === 'sol_transfer').map(i => ({ to: i.to, lamports: i.lamports }));
    const out = await executeSquadsTransfer(connection(), ex.keys, ex.state, transfers, { memo: `trustlayer:${t.id.slice(0, 8)}` });
    const done = store.updateTransaction(t.id, { status: 'executed', transaction_signature: out.sig, execution: out });
    return { transaction: done, ...pick(result), events, signature: out.sig };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    const failed = store.updateTransaction(t.id, { status: 'failed', rejection_reason: `Execution failed after approval: ${msg}` });
    events.push(store.insertSecurityEvent({ agentId: agent.id, eventType: 'execution_failed', description: msg, transactionId: t.id }));
    return { transaction: failed, ...pick(result), decision: 'FAILED', allow: false, reasons: [msg], events };
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
    approved: txs.filter(t => t.status === 'approved' || t.status === 'executed' || t.status === 'reserved').length,
    executed: txs.filter(t => t.status === 'executed').length,
    rejected: txs.filter(t => t.status === 'rejected').length,
    authorizedLamports: txs.filter(t => t.status === 'executed').reduce((s, t) => s + t.amount_lamports, 0),
    securityEvents: store.listSecurityEvents({ userId, limit: 100000 }).length,
    simulationMode: SIMULATION_MODE,
  };
}

export { fmtSol };
