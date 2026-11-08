// TrustLayer policy engine (off-chain, evaluated at the approval step).
// A proposal is evaluated against policies/default.json BEFORE the
// gatekeeper signs its approval in the Squads 2-of-2 multisig.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadPolicy(file = 'policies/default.json') {
  const p = path.resolve(process.cwd(), file);
  return { path: p, policy: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

export class AuditLog {
  // scope: {cluster, policyVersion} — when set, every recorded entry is
  // stamped with it and spend/replay accounting counts ONLY entries from the
  // same scope. One policy version's budgets are never polluted by executions
  // on another cluster (local validator vs devnet) or under another policy
  // version. The full history stays in the log; scoping changes what counts,
  // never what is preserved.
  constructor(file = 'data/audit.log', scope = null) {
    this.file = path.resolve(process.cwd(), file);
    this.scope = scope;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }
  record(entry) {
    const stamp = this.scope ? { cluster: this.scope.cluster, policyVersion: this.scope.policyVersion } : {};
    const line = JSON.stringify({ ts: new Date().toISOString(), ...stamp, ...entry });
    fs.appendFileSync(this.file, line + '\n');
    return line;
  }
  _inScope(e) {
    if (!this.scope) return true;
    return e.cluster === this.scope.cluster && e.policyVersion === this.scope.policyVersion;
  }
  recent(limit = 100) {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l));
  }
  // All spend arithmetic is integer lamports: SOL floats cannot represent
  // 0.04 + 0.06 exactly, which wrongly rejected exactly-at-cap requests.
  spentTodayLamports(windowStart) {
    if (!fs.existsSync(this.file)) return 0;
    return this.recent(10000)
      .filter(e => this._inScope(e) && e.decision === 'allowed' && e.executed === true && new Date(e.ts).getTime() >= windowStart)
      .reduce((s, e) => s + Math.round((e.amountSol || 0) * 1e9), 0);
  }
  // Sum of executed spends plus held (not yet settled) reservations.
  // Entries: {id, reserved, amountSol} at decision time, {id, executed:true, amountSol}
  // on success, {id, released:true} on failure. Legacy id-less executed entries count directly.
  spentTotal() {
    if (!fs.existsSync(this.file)) return 0;
    const ents = this.recent(10000);
    const state = new Map();
    for (const e of ents) {
      if (!this._inScope(e)) continue;
      if (!e.id) { if (e.decision === 'allowed' && e.executed === true) state.set(Symbol(), { amount: e.amountSol || 0, status: 'executed' }); continue; }
      const cur = state.get(e.id) || { amount: e.amountSol || 0, status: 'none' };
      if (e.amountSol != null) cur.amount = e.amountSol;
      if (e.released) cur.status = 'released';
      else if (e.executed === true) cur.status = 'executed';
      else if (e.reserved) cur.status = 'reserved';
      state.set(e.id, cur);
    }
    let total = 0;
    for (const v of state.values()) if (v.status === 'executed' || v.status === 'reserved') total += Math.round(v.amount * 1e9);
    return total; // lamports
  }
  // Replay protection: a caller-supplied nonce is consumed only by a successful
  // execution. Rejected or released attempts leave it free so retries work.
  nonceState(nonce) {
    if (nonce == null || !fs.existsSync(this.file)) return 'free';
    const n = String(nonce);
    let s = 'free';
    for (const e of this.recent(10000)) {
      if (!this._inScope(e) || e.nonce !== n) continue;
      if (e.released) s = 'free';
      else if (e.executed === true) return 'consumed';
      else if (e.reserved) s = 'inflight';
    }
    return s;
  }
}

// Authorization identity for one-time use: bound to the canonical transaction
// content (program, action, destination, integer lamports) and policy version.
// Only enforced when the policy declares oneTimeUse - an optional caller nonce
// alone protects only clients that opt in, so no universal replay protection
// is claimed without it.
export function deriveAuthId(policy, tx, amtL) {
  const canon = [
    'v' + (policy.version ?? 0),
    String(tx.action || 'transfer'),
    String(tx.programId || '11111111111111111111111111111111'),
    String(tx.destination || ''),
    String(amtL),
  ].join('|');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

// Evaluate one proposed transfer against the policy.
// tx: { destination, amountSol, programId, memo? }
// Returns { allow, reasons[], policyVersion, authId } - authId is the
// authorization identity to record (caller nonce or derived one-time id).
export function evaluate(policy, tx, audit) {
  const reasons = [];
  const dest = String(tx.destination || '');
  const amt = Number(tx.amountSol);
  const amtL = Math.round(amt * 1e9); // integer lamports for all comparisons
  const prog = String(tx.programId || '11111111111111111111111111111111');
  const action = String(tx.action || 'transfer');

  if (policy.expiresAt && Date.now() > new Date(policy.expiresAt).getTime())
    reasons.push(`policy expired at ${policy.expiresAt}`);

  if (policy.allowedActions?.length && !policy.allowedActions.includes(action))
    reasons.push(`action "${action}" not permitted by policy`);

  if (!(amt > 0)) reasons.push(`invalid amount: ${tx.amountSol}`);
  if (amtL > Math.round(policy.maxSolPerTransaction * 1e9))
    reasons.push(`amount ${amt} SOL exceeds per-transaction limit ${policy.maxSolPerTransaction} SOL`);

  const windowStart = Date.now() - DAY_MS;
  const spentTodayL = audit ? audit.spentTodayLamports(windowStart) : 0;
  if (policy.maxSolPerDay != null && spentTodayL + amtL > Math.round(policy.maxSolPerDay * 1e9))
    reasons.push(`daily limit exceeded: ${(spentTodayL / 1e9).toFixed(4)} spent + ${amt} requested > ${policy.maxSolPerDay} SOL/day`);

  const spentTotalL = audit ? audit.spentTotal() : 0;
  if (policy.maxSolTotal != null && spentTotalL + amtL > Math.round(policy.maxSolTotal * 1e9))
    reasons.push(`total budget exceeded: ${(spentTotalL / 1e9).toFixed(4)} spent + ${amt} requested > ${policy.maxSolTotal} SOL total`);

  const authId = tx.nonce != null ? String(tx.nonce)
    : (policy.oneTimeUse ? deriveAuthId(policy, tx, amtL) : null);
  if (authId != null && audit) {
    const ns = audit.nonceState(authId);
    if (ns === 'consumed') reasons.push(`authorization ${authId} already consumed - replay rejected`);
    else if (ns === 'inflight') reasons.push(`authorization ${authId} already in flight`);
  }

  if (policy.allowedPrograms?.length && !policy.allowedPrograms.includes(prog))
    reasons.push(`program ${prog} not in allowlist`);

  if (policy.blockedDestinations?.includes(dest))
    reasons.push(`destination ${dest} is explicitly blocked`);
  else if (policy.allowedDestinations?.length && !policy.allowedDestinations.includes(dest))
    reasons.push(`destination ${dest} not in allowlist`);

  return { allow: reasons.length === 0, reasons, policyVersion: policy.version ?? 0, authId };
}
