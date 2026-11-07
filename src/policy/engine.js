// TrustLayer policy engine (off-chain, evaluated at the approval step).
// A proposal is evaluated against policies/default.json BEFORE the
// gatekeeper signs its approval in the Squads 2-of-2 multisig.
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadPolicy(file = 'policies/default.json') {
  const p = path.resolve(process.cwd(), file);
  return { path: p, policy: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

export class AuditLog {
  constructor(file = 'data/audit.log') {
    this.file = path.resolve(process.cwd(), file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }
  record(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(this.file, line + '\n');
    return line;
  }
  recent(limit = 100) {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l));
  }
  spentToday(windowStart) {
    if (!fs.existsSync(this.file)) return 0;
    return this.recent(10000)
      .filter(e => e.decision === 'allowed' && e.executed === true && new Date(e.ts).getTime() >= windowStart)
      .reduce((s, e) => s + (e.amountSol || 0), 0);
  }
  spentTotal() {
    return this.spentToday(0);
  }
}

// Evaluate one proposed transfer against the policy.
// tx: { destination, amountSol, programId, memo? }
// Returns { allow, reasons[], policyVersion }
export function evaluate(policy, tx, audit) {
  const reasons = [];
  const dest = String(tx.destination || '');
  const amt = Number(tx.amountSol);
  const prog = String(tx.programId || '11111111111111111111111111111111');
  const action = String(tx.action || 'transfer');

  if (policy.expiresAt && Date.now() > new Date(policy.expiresAt).getTime())
    reasons.push(`policy expired at ${policy.expiresAt}`);

  if (policy.allowedActions?.length && !policy.allowedActions.includes(action))
    reasons.push(`action "${action}" not permitted by policy`);

  if (!(amt > 0)) reasons.push(`invalid amount: ${tx.amountSol}`);
  if (amt > policy.maxSolPerTransaction)
    reasons.push(`amount ${amt} SOL exceeds per-transaction limit ${policy.maxSolPerTransaction} SOL`);

  const windowStart = Date.now() - DAY_MS;
  const spentToday = audit ? audit.spentToday(windowStart) : 0;
  if (policy.maxSolPerDay != null && spentToday + amt > policy.maxSolPerDay)
    reasons.push(`daily limit exceeded: ${spentToday.toFixed(4)} spent + ${amt} requested > ${policy.maxSolPerDay} SOL/day`);

  const spentTotal = audit ? audit.spentTotal() : 0;
  if (policy.maxSolTotal != null && spentTotal + amt > policy.maxSolTotal)
    reasons.push(`total budget exceeded: ${spentTotal.toFixed(4)} spent + ${amt} requested > ${policy.maxSolTotal} SOL total`);

  if (policy.allowedPrograms?.length && !policy.allowedPrograms.includes(prog))
    reasons.push(`program ${prog} not in allowlist`);

  if (policy.blockedDestinations?.includes(dest))
    reasons.push(`destination ${dest} is explicitly blocked`);
  else if (policy.allowedDestinations?.length && !policy.allowedDestinations.includes(dest))
    reasons.push(`destination ${dest} not in allowlist`);

  return { allow: reasons.length === 0, reasons, policyVersion: policy.version ?? 0 };
}
