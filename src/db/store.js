// TrustLayer data store (PRD section 10).
//
// A small relational-shaped store kept in one JSON file (data/db.json) with
// the PRD's tables: users, agents, policies, transactions, security_events.
// Writes are synchronous and atomic (write temp file + rename), and the API
// runs in one Node process, so a read-check-insert sequence with no `await`
// in between is atomic. That is what makes spending reservations safe
// against concurrent proposals (PRD 12.2).
//
// The shape maps 1:1 onto the PRD's PostgreSQL schema; swapping this module
// for a Postgres/Supabase adapter only needs the same function signatures.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ users: [], agents: [], policies: [], policy_versions: [], transactions: [], security_events: [], sessions: [] });

export class Store {
  constructor(file = process.env.TRUSTLAYER_DB || 'data/db.json') {
    this.file = path.resolve(process.cwd(), file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = fs.existsSync(this.file) ? { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } : EMPTY();
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
  static id() { return crypto.randomUUID(); }
  static now() { return new Date().toISOString(); }

  // ---- users -------------------------------------------------------------
  upsertUser(walletAddress) {
    let u = this.db.users.find(x => x.wallet_address === walletAddress);
    if (!u) { u = { id: Store.id(), wallet_address: walletAddress, created_at: Store.now() }; this.db.users.push(u); this.save(); }
    return u;
  }
  getUser(id) { return this.db.users.find(u => u.id === id) || null; }

  // ---- sessions (owner sign-in) -----------------------------------------
  createSession(userId, ttlMs = 12 * 3600e3) {
    const token = 'tls_' + crypto.randomBytes(24).toString('base64url');
    this.db.sessions = this.db.sessions.filter(s => new Date(s.expires_at) > new Date());
    this.db.sessions.push({ token_hash: sha256(token), user_id: userId, expires_at: new Date(Date.now() + ttlMs).toISOString() });
    this.save();
    return token;
  }
  sessionUser(token) {
    if (!token) return null;
    const s = this.db.sessions.find(x => x.token_hash === sha256(token) && new Date(x.expires_at) > new Date());
    return s ? this.getUser(s.user_id) : null;
  }

  // ---- agents ------------------------------------------------------------
  createAgent({ userId, name, walletAddress }) {
    const apiKey = 'tla_' + crypto.randomBytes(24).toString('base64url');
    const a = { id: Store.id(), user_id: userId, name, wallet_address: walletAddress, status: 'active', api_key_hash: sha256(apiKey), created_at: Store.now(), updated_at: Store.now() };
    this.db.agents.push(a); this.save();
    return { agent: a, apiKey };
  }
  rotateAgentKey(id) {
    const a = this.getAgent(id); if (!a) return null;
    const apiKey = 'tla_' + crypto.randomBytes(24).toString('base64url');
    a.api_key_hash = sha256(apiKey); a.updated_at = Store.now(); this.save();
    return apiKey;
  }
  getAgent(id) { return this.db.agents.find(a => a.id === id) || null; }
  agentByKey(apiKey) { return apiKey ? this.db.agents.find(a => a.api_key_hash === sha256(apiKey)) || null : null; }
  listAgents(userId) { return this.db.agents.filter(a => !userId || a.user_id === userId); }
  updateAgent(id, patch) {
    const a = this.getAgent(id); if (!a) return null;
    for (const k of ['name', 'wallet_address', 'status']) if (patch[k] !== undefined) a[k] = patch[k];
    a.updated_at = Store.now(); this.save();
    return a;
  }

  // ---- policies (one active policy per agent, every version kept) --------
  createPolicy({ agentId, maxTransactionLamports, spendingLimitLamports, approvedRecipients, allowedActions, expiresAt }) {
    // A new policy for an agent replaces its current one.
    for (const p of this.db.policies) if (p.agent_id === agentId && p.active) p.active = false;
    const p = {
      id: Store.id(), agent_id: agentId, version: 1, active: true,
      max_transaction_lamports: maxTransactionLamports, spending_limit_lamports: spendingLimitLamports,
      approved_recipients: approvedRecipients, allowed_actions: allowedActions,
      expires_at: expiresAt, created_at: Store.now(), updated_at: Store.now(),
    };
    this.db.policies.push(p);
    this.db.policy_versions.push({ ...p, policy_id: p.id, id: Store.id() });
    this.save();
    return p;
  }
  getPolicy(id) { return this.db.policies.find(p => p.id === id) || null; }
  policyForAgent(agentId) { return this.db.policies.find(p => p.agent_id === agentId && p.active) || null; }
  updatePolicy(id, patch) {
    const p = this.getPolicy(id); if (!p) return null;
    for (const k of ['max_transaction_lamports', 'spending_limit_lamports', 'approved_recipients', 'allowed_actions', 'expires_at'])
      if (patch[k] !== undefined) p[k] = patch[k];
    p.version += 1; p.updated_at = Store.now();
    this.db.policy_versions.push({ ...p, policy_id: p.id, id: Store.id() });
    this.save();
    return p;
  }

  // ---- transactions ------------------------------------------------------
  // status: approved (evaluate only) | rejected | reserved | proposed (awaiting gatekeeper) | executed | failed
  insertTransaction(row) {
    const t = { id: Store.id(), created_at: Store.now(), transaction_signature: null, rejection_reason: null, ...row };
    this.db.transactions.push(t); this.save();
    return t;
  }
  updateTransaction(id, patch) {
    const t = this.db.transactions.find(x => x.id === id); if (!t) return null;
    Object.assign(t, patch, { updated_at: Store.now() }); this.save();
    return t;
  }
  listTransactions({ userId, agentId, limit = 200 } = {}) {
    const agentIds = userId ? new Set(this.listAgents(userId).map(a => a.id)) : null;
    return this.db.transactions
      .filter(t => (!agentIds || agentIds.has(t.agent_id)) && (!agentId || t.agent_id === agentId))
      .slice(-limit).reverse();
  }
  // Committed spend under a policy: executed transfers plus held reservations.
  // Bumping a policy's version never resets it; only a new policy does.
  spentLamports(policyId) {
    return this.db.transactions
      .filter(t => t.policy_id === policyId && ['executed', 'reserved', 'proposed'].includes(t.status))
      .reduce((s, t) => s + t.amount_lamports, 0);
  }
  // Content-bound one-time authorizations: an executed (or in-flight)
  // authorization id cannot be used again.
  authState(policyId, authId) {
    const t = this.db.transactions.find(x => x.policy_id === policyId && x.auth_id === authId && ['executed', 'reserved', 'proposed'].includes(x.status));
    return t ? t.status : 'free';
  }

  // ---- security events ---------------------------------------------------
  insertSecurityEvent({ agentId, eventType, description, transactionId }) {
    const e = { id: Store.id(), agent_id: agentId, event_type: eventType, description, transaction_id: transactionId || null, created_at: Store.now() };
    this.db.security_events.push(e); this.save();
    return e;
  }
  listSecurityEvents({ userId, limit = 200 } = {}) {
    const agentIds = userId ? new Set(this.listAgents(userId).map(a => a.id)) : null;
    return this.db.security_events.filter(e => !agentIds || agentIds.has(e.agent_id)).slice(-limit).reverse();
  }
}

export function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Public view of an agent: never return the key hash.
export function publicAgent(a) {
  if (!a) return null;
  const { api_key_hash, ...rest } = a;
  return rest;
}
