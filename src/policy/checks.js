// Deterministic policy evaluation (PRD Module 4).
//
// Pure function: same inputs, same verdict. No network, no clock other than
// the `now` passed in, no LLM. Every check in the PRD table runs and reports
// pass/fail with a plain-English reason, so a rejection always says why -
// and a reviewer sees every check that ran, not just the first failure.
import crypto from 'node:crypto';

export const SOL = 1e9;
export const fmtSol = (l) => `${+(l / SOL).toFixed(9)} SOL`;

export const ACTION_LABELS = { sol_transfer: 'SOL transfers', spl_transfer: 'SPL token transfers' };

// Security event type raised by each failing check (PRD Module 6 D).
export const EVENT_FOR_CHECK = {
  agent_status: 'inactive_agent',
  permission_expiry: 'expired_permission',
  inspection: 'unsupported_transaction',
  sender: 'sender_mismatch',
  action: 'disallowed_action',
  transaction_limit: 'transaction_limit_violation',
  spending_limit: 'spending_limit_violation',
  recipient: 'unauthorized_recipient',
  replay: 'replay_attempt',
  simulation: 'failed_simulation',
};

// Authorization identity: bound to the policy version and the exact decoded
// instructions. Used for caller nonces (one-time use) and the audit record.
export function authorizationId(policy, inspection, nonce) {
  const body = [policy.id, 'v' + policy.version, nonce ?? '',
    ...inspection.instructions.map(i => [i.programId, i.action, i.from, i.to, i.lamports].join(':'))].join('|');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 20);
}

/**
 * @param {object} p
 * @param {object} p.agent        agent row
 * @param {object|null} p.policy  active policy row
 * @param {object} p.inspection   output of inspectProposal
 * @param {number} p.spentLamports committed spend (executed + reserved) under this policy
 * @param {object} p.simulation   output of simulateInspection
 * @param {string} p.authState    'free' | 'reserved' | 'executed' for this proposal's nonce
 * @param {number} p.now          ms timestamp
 */
export function evaluatePolicy({ agent, policy, inspection, spentLamports = 0, simulation, authState = 'free', nonce = null, now = Date.now() }) {
  const checks = [];
  const add = (id, label, pass, reason) => checks.push({ id, label, pass, reason });

  add('agent_status', 'Agent status', agent?.status === 'active',
    agent?.status === 'active' ? 'Agent is active.' : 'Agent is inactive and cannot submit transactions for authorization.');

  if (!policy) {
    add('permission_expiry', 'Permission', false, 'No permission policy is configured for this agent.');
  } else {
    const exp = new Date(policy.expires_at).getTime();
    add('permission_expiry', 'Permission expiry', now < exp,
      now < exp ? `Permission valid until ${new Date(exp).toISOString()}.` : `Permission expired at ${new Date(exp).toISOString()}.`);
  }

  add('inspection', 'Transaction decoding', inspection.unsupported.length === 0,
    inspection.unsupported.length === 0
      ? `Decoded ${inspection.instructions.length} instruction${inspection.instructions.length === 1 ? '' : 's'}; all supported.`
      : `Unsupported instruction${inspection.unsupported.length === 1 ? '' : 's'}: ${inspection.unsupported.join('; ')}.`);

  const senderOk = inspection.senders.length > 0 && inspection.senders.every(s => s === agent?.wallet_address);
  add('sender', 'Sender', senderOk,
    senderOk ? 'Funds come from the agent\'s registered vault.'
      : `Funds must come from the agent's registered vault ${agent?.wallet_address}; transaction spends from ${inspection.senders.join(', ') || 'nothing'}.`);

  if (policy) {
    const allowed = policy.allowed_actions || [];
    const bad = inspection.actions.filter(a => !allowed.includes(a));
    add('action', 'Allowed action', bad.length === 0 && inspection.actions.length > 0,
      bad.length === 0 && inspection.actions.length > 0
        ? `Action permitted (${inspection.actions.map(a => ACTION_LABELS[a] || a).join(', ')}).`
        : `Action "${bad[0] ?? 'none'}" is not permitted. This agent may only perform: ${allowed.map(a => ACTION_LABELS[a] || a).join(', ') || 'nothing'}.`);

    const amt = inspection.lamports;
    add('transaction_limit', 'Transaction limit', amt > 0 && amt <= policy.max_transaction_lamports,
      amt <= policy.max_transaction_lamports
        ? `${fmtSol(amt)} is within the ${fmtSol(policy.max_transaction_lamports)} per-transaction limit.`
        : `Transaction amount ${fmtSol(amt)} exceeds the maximum authorized limit of ${fmtSol(policy.max_transaction_lamports)} per transaction.`);

    const after = spentLamports + amt;
    add('spending_limit', 'Spending limit', after <= policy.spending_limit_lamports,
      after <= policy.spending_limit_lamports
        ? `${fmtSol(spentLamports)} spent + ${fmtSol(amt)} = ${fmtSol(after)}, within the ${fmtSol(policy.spending_limit_lamports)} total limit.`
        : `Cumulative spending would exceed the total limit: ${fmtSol(spentLamports)} spent + ${fmtSol(amt)} requested > ${fmtSol(policy.spending_limit_lamports)}.`);

    const list = policy.approved_recipients || [];
    const okSet = new Set(list.map(r => r.address));
    const unknown = inspection.recipients.filter(r => !okSet.has(r));
    const names = inspection.recipients.map(r => list.find(x => x.address === r)?.label || short(r));
    add('recipient', 'Recipient', inspection.recipients.length > 0 && unknown.length === 0,
      unknown.length === 0 && inspection.recipients.length
        ? `Recipient ${names.join(', ')} is on the approved list.`
        : `Recipient ${unknown.map(short).join(', ') || '(none)'} is not authorized by the agent's permission policy.`);
  }

  if (nonce != null) {
    add('replay', 'One-time authorization', authState === 'free',
      authState === 'free' ? `Nonce ${nonce} is unused.` : `Nonce ${nonce} was already ${authState === 'executed' ? 'used' : 'reserved by a transaction in flight'} - replay rejected.`);
  }

  if (simulation === null) checks.push({ id: 'simulation', label: 'Simulation', pass: null, reason: 'Not run: the transaction did not pass inspection.' });
  else add('simulation', 'Simulation', !!simulation?.ok,
    simulation?.ok
      ? (simulation.ran ? `Simulated on ${simulation.cluster}: success (${simulation.unitsConsumed ?? '?'} compute units).` : simulation.note)
      : `Simulation failed: ${simulation?.error || 'not run'}.`);

  const failed = checks.filter(c => c.pass === false);
  return {
    allow: failed.length === 0,
    decision: failed.length === 0 ? 'APPROVED' : 'BLOCKED',
    checks,
    reasons: failed.map(c => c.reason),
    explanation: failed.length === 0 ? 'All policy checks passed.' : failed[0].reason,
    events: failed.map(c => ({ eventType: EVENT_FOR_CHECK[c.id], description: c.reason })),
    policyId: policy?.id ?? null,
    policyVersion: policy?.version ?? null,
  };
}

export function short(a) { return a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a); }
