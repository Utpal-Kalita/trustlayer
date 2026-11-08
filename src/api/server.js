// TrustLayer backend API (PRD section 11) + static site host. node:http, no framework.
//
// Auth:
//   owner  - `Authorization: Bearer tls_…` session from wallet sign-in
//            (POST /api/auth/challenge -> sign with Phantom -> POST /api/auth/verify),
//            or `x-trustlayer-key: $TRUSTLAYER_API_KEY` for scripts.
//   agent  - `x-agent-key: tla_…`, issued once when the agent is registered.
//            An agent can only propose for itself; it can never touch policies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { Store, publicAgent } from '../db/store.js';
import { isAddress, solToLamports } from '../inspect/inspector.js';
import { authorize, overview, executionStatus } from '../service.js';
import { SIMULATION_MODE, RPC_URL } from '../inspect/simulate.js';
import { loadKeys } from '../onchain.js';

const PORT = Number(process.env.PORT || 8787);
const store = new Store();
const ACTIONS = ['sol_transfer', 'spl_transfer'];
const challenges = new Map(); // wallet -> { message, expires }

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 256e3) { reject(new HttpError(413, 'request body too large')); req.destroy(); } });
    req.on('end', () => { if (!d) return resolve({}); try { resolve(JSON.parse(d)); } catch { reject(new HttpError(400, 'body is not valid JSON')); } });
    req.on('error', reject);
  });
}
function adminUser() {
  let wallet = 'admin';
  try { wallet = loadKeys().owner.publicKey.toBase58(); } catch { /* no keys */ }
  return store.upsertUser(wallet);
}
function ownerFrom(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) { const u = store.sessionUser(auth.slice(7)); if (u) return u; }
  const k = process.env.TRUSTLAYER_API_KEY;
  if (k && req.headers['x-trustlayer-key'] && safeEq(req.headers['x-trustlayer-key'], k)) return adminUser();
  return null;
}
function requireOwner(req) { const u = ownerFrom(req); if (!u) throw new HttpError(401, 'sign in with your wallet first'); return u; }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function ownedAgent(user, id) {
  const a = store.getAgent(id);
  if (!a || a.user_id !== user.id) throw new HttpError(404, 'agent not found');
  return a;
}
function agentView(a) {
  const policy = store.policyForAgent(a.id);
  return { ...publicAgent(a), policy_id: policy?.id ?? null, policy: policy ? policyView(policy) : null, spent_lamports: policy ? store.spentLamports(policy.id) : 0 };
}
function policyView(p) { return { ...p, expired: Date.now() >= new Date(p.expires_at).getTime() }; }

function parsePolicyInput(b, { partial = false } = {}) {
  const out = {};
  if (b.maxTransactionSol !== undefined || !partial) {
    const v = solToLamports(b.maxTransactionSol);
    if (!(v > 0)) throw new HttpError(400, 'maxTransactionSol must be a positive SOL amount');
    out.max_transaction_lamports = v;
  }
  if (b.spendingLimitSol !== undefined || !partial) {
    const v = solToLamports(b.spendingLimitSol);
    if (!(v > 0)) throw new HttpError(400, 'spendingLimitSol must be a positive SOL amount');
    out.spending_limit_lamports = v;
  }
  if (b.approvedRecipients !== undefined || !partial) {
    if (!Array.isArray(b.approvedRecipients) || b.approvedRecipients.length > 50) throw new HttpError(400, 'approvedRecipients must be a list (max 50)');
    out.approved_recipients = b.approvedRecipients.map((r, i) => {
      const address = String(typeof r === 'string' ? r : r?.address || '').trim();
      if (!isAddress(address)) throw new HttpError(400, `approved recipient #${i + 1} is not a valid Solana address`);
      return { label: String((typeof r === 'object' && r.label) || `Recipient ${i + 1}`).slice(0, 60), address };
    });
  }
  if (b.allowedActions !== undefined || !partial) {
    const acts = b.allowedActions ?? ['sol_transfer'];
    if (!Array.isArray(acts) || !acts.every(a => ACTIONS.includes(a))) throw new HttpError(400, `allowedActions must be a subset of ${ACTIONS.join(', ')}`);
    out.allowed_actions = [...new Set(acts)];
  }
  if (b.expiresAt !== undefined || b.expiresInHours !== undefined || !partial) {
    const t = b.expiresAt ? new Date(b.expiresAt).getTime() : Date.now() + Number(b.expiresInHours ?? 2) * 3600e3;
    if (!Number.isFinite(t)) throw new HttpError(400, 'expiresAt / expiresInHours is not a valid time');
    out.expires_at = new Date(t).toISOString();
  }
  if (out.max_transaction_lamports && out.spending_limit_lamports && out.max_transaction_lamports > out.spending_limit_lamports)
    throw new HttpError(400, 'maxTransactionSol cannot be larger than spendingLimitSol');
  return out;
}

// Who is proposing: the agent itself (x-agent-key) or its owner from the console.
function proposer(req, body) {
  const key = req.headers['x-agent-key'];
  if (key) {
    const a = store.agentByKey(String(key));
    if (!a) throw new HttpError(401, 'invalid agent key');
    if (body.agentId && body.agentId !== a.id) throw new HttpError(403, 'an agent key can only propose for its own agent');
    return { agent: a, source: 'agent-api' };
  }
  const u = ownerFrom(req);
  if (!u) throw new HttpError(401, 'send x-agent-key, or sign in as the agent\'s owner');
  if (!body.agentId) throw new HttpError(400, 'agentId is required');
  return { agent: ownedAgent(u, body.agentId), source: 'owner-console' };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', () => ({
  ok: true, service: 'trustlayer-api', time: new Date().toISOString(),
  cluster: new URL(RPC_URL).host, simulation: SIMULATION_MODE,
  execution: (({ enabled, reason, vault, multisig }) => ({ enabled, reason, vault, multisig }))(executionStatus(null)),
  demoLogin: process.env.TRUSTLAYER_DEMO_LOGIN === '1',
}));

// Wallet sign-in: sign a one-time message with the wallet (Phantom signMessage).
route('POST', '/api/auth/challenge', async (req) => {
  const { wallet } = await readBody(req);
  if (!isAddress(wallet)) throw new HttpError(400, 'wallet must be a Solana address');
  const message = `TrustLayer sign-in\nWallet: ${wallet}\nNonce: ${crypto.randomBytes(12).toString('hex')}\nIssued: ${new Date().toISOString()}`;
  challenges.set(wallet, { message, expires: Date.now() + 5 * 60e3 });
  return { message };
});
route('POST', '/api/auth/verify', async (req) => {
  const { wallet, signature } = await readBody(req);
  const c = challenges.get(wallet);
  if (!c || c.expires < Date.now()) throw new HttpError(400, 'challenge expired - request a new one');
  let ok = false;
  try { ok = ed25519.verify(bs58.decode(String(signature)), new TextEncoder().encode(c.message), bs58.decode(wallet)); } catch { ok = false; }
  if (!ok) throw new HttpError(401, 'signature does not match this wallet');
  challenges.delete(wallet);
  const user = store.upsertUser(wallet);
  return { token: store.createSession(user.id), user };
});
// Judges without a browser wallet: sign in as the demo owner (opt-in, devnet demo only).
route('POST', '/api/auth/demo', () => {
  if (process.env.TRUSTLAYER_DEMO_LOGIN !== '1') throw new HttpError(403, 'demo sign-in is disabled on this server');
  const user = adminUser();
  return { token: store.createSession(user.id, 2 * 3600e3), user, demo: true };
});
route('GET', '/api/me', (req) => ({ user: requireOwner(req) }));

// Agents (Module 1)
route('POST', '/api/agents', async (req) => {
  const user = requireOwner(req);
  const b = await readBody(req);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'name is required');
  let wallet = String(b.walletAddress || '').trim();
  if (!wallet) wallet = executionStatus(null).vault || '';
  if (!isAddress(wallet)) throw new HttpError(400, 'walletAddress must be a Solana address (the agent\'s Squads vault)');
  const { agent, apiKey } = store.createAgent({ userId: user.id, name, walletAddress: wallet });
  let policy = null;
  if (b.policy) policy = store.createPolicy({ agentId: agent.id, ...camel(parsePolicyInput(b.policy)) });
  return { status: 201, body: { agent: agentView(agent), apiKey, policy, note: 'Store the agent key now: it is shown once.' } };
});
route('GET', '/api/agents', (req) => ({ agents: store.listAgents(requireOwner(req).id).map(agentView) }));
route('GET', '/api/agents/:id', (req, p) => ({ agent: agentView(ownedAgent(requireOwner(req), p.id)) }));
route('PATCH', '/api/agents/:id', async (req, p) => {
  const a = ownedAgent(requireOwner(req), p.id);
  const b = await readBody(req);
  const patch = {};
  if (b.name !== undefined) { patch.name = String(b.name).trim().slice(0, 60); if (!patch.name) throw new HttpError(400, 'name cannot be empty'); }
  if (b.walletAddress !== undefined) { if (!isAddress(b.walletAddress)) throw new HttpError(400, 'walletAddress must be a Solana address'); patch.wallet_address = b.walletAddress; }
  if (b.status !== undefined) { if (!['active', 'inactive'].includes(b.status)) throw new HttpError(400, 'status must be active or inactive'); patch.status = b.status; }
  const updated = store.updateAgent(a.id, patch);
  if (patch.status && patch.status !== a.status)
    store.insertSecurityEvent({ agentId: a.id, eventType: patch.status === 'inactive' ? 'agent_deactivated' : 'agent_reactivated', description: `Owner set agent "${a.name}" to ${patch.status}.` });
  return { agent: agentView(updated) };
});
route('POST', '/api/agents/:id/rotate-key', (req, p) => {
  const a = ownedAgent(requireOwner(req), p.id);
  const apiKey = store.rotateAgentKey(a.id);
  store.insertSecurityEvent({ agentId: a.id, eventType: 'agent_key_rotated', description: `Owner revoked the old key of "${a.name}" and issued a new one.` });
  return { apiKey, note: 'The previous key no longer works.' };
});

// Policies (Module 2)
route('POST', '/api/policies', async (req) => {
  const user = requireOwner(req);
  const b = await readBody(req);
  const a = ownedAgent(user, b.agentId);
  return { status: 201, body: { policy: policyView(store.createPolicy({ agentId: a.id, ...camel(parsePolicyInput(b)) })) } };
});
route('GET', '/api/policies/:agentId', (req, p) => {
  const a = ownedAgent(requireOwner(req), p.agentId);
  const policy = store.policyForAgent(a.id);
  if (!policy) throw new HttpError(404, 'this agent has no policy yet');
  return { policy: policyView(policy), spent_lamports: store.spentLamports(policy.id) };
});
route('PATCH', '/api/policies/:id', async (req, p) => {
  const user = requireOwner(req);
  const policy = store.getPolicy(p.id);
  if (!policy) throw new HttpError(404, 'policy not found');
  ownedAgent(user, policy.agent_id);
  const patch = parsePolicyInput(await readBody(req), { partial: true });
  const merged = { ...policy, ...patch };
  if (merged.max_transaction_lamports > merged.spending_limit_lamports) throw new HttpError(400, 'maxTransactionSol cannot be larger than spendingLimitSol');
  const updated = store.updatePolicy(policy.id, patch);
  return { policy: policyView(updated) };
});

// Transactions (Modules 3-5)
route('POST', '/api/transactions/evaluate', async (req) => {
  const body = await readBody(req);
  const { agent, source } = proposer(req, body);
  return strip(await authorize(store, agent, body, { execute: false, source }));
});
route('POST', '/api/transactions/execute', async (req) => {
  const body = await readBody(req);
  const { agent, source } = proposer(req, body);
  // Ignore any client claim of prior approval: the full pipeline runs again here.
  delete body.approved; delete body.evaluationId;
  return strip(await authorize(store, agent, body, { execute: true, source }));
});
route('GET', '/api/transactions', (req, _p, url) => {
  const user = requireOwner(req);
  const names = Object.fromEntries(store.listAgents(user.id).map(a => [a.id, a.name]));
  return { transactions: store.listTransactions({ userId: user.id, agentId: url.searchParams.get('agentId') || undefined }).map(t => ({ ...t, agent_name: names[t.agent_id] })) };
});
route('GET', '/api/security-events', (req) => {
  const user = requireOwner(req);
  const names = Object.fromEntries(store.listAgents(user.id).map(a => [a.id, a.name]));
  return { events: store.listSecurityEvents({ userId: user.id }).map(e => ({ ...e, agent_name: names[e.agent_id] })) };
});
route('GET', '/api/overview', (req) => overview(store, requireOwner(req).id));

// Read-only JSON-RPC proxy for edge clients (whitelisted read methods only).
route('POST', '/api/rpc', async (req) => {
  const ALLOWED = new Set(['getSignaturesForAddress', 'getTransaction', 'getHealth', 'getLatestBlockhash', 'getBalance']);
  const { method, params, id } = await readBody(req);
  if (!ALLOWED.has(method)) throw new HttpError(403, 'method not allowed');
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, method, params }) });
  return { status: r.ok ? 200 : 502, body: await r.json() };
});

function camel(p) {
  return { maxTransactionLamports: p.max_transaction_lamports, spendingLimitLamports: p.spending_limit_lamports, approvedRecipients: p.approved_recipients, allowedActions: p.allowed_actions, expiresAt: p.expires_at };
}
function strip(r) { return { ...r, transaction: r.transaction && { ...r.transaction, proposal: undefined } }; }

// ---------------------------------------------------------------- server
const STATIC_ROOT = path.resolve(process.cwd(), 'dashboard');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-trustlayer-key,x-agent-key', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      try {
        const out = await r.fn(req, m.groups || {}, url);
        return out?.status ? json(res, out.status, out.body) : json(res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) return json(res, e.code, { error: e.message });
        console.error(e);
        return json(res, 500, { error: 'internal error' });
      }
    }
    return json(res, 404, { error: 'not found' });
  }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel === 'app') rel = 'app.html';
  const fp = path.resolve(STATIC_ROOT, rel);
  if (req.method === 'GET' && fp.startsWith(STATIC_ROOT + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    return fs.createReadStream(fp).pipe(res);
  }
  return json(res, 404, { error: 'not found' });
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`TrustLayer on http://localhost:${PORT}  (simulation: ${SIMULATION_MODE}, cluster: ${new URL(RPC_URL).host})`));
}
export { store };
