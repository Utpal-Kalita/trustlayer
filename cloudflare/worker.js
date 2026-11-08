// TrustLayer API — Cloudflare Worker (read-only parity + durable gate prototype)
// Policy evaluation + on-chain-derived budget checks; signing DISABLED on this host.
// Durable Object PolicyGate: single-writer serializable reservation state that
// survives restarts/redeploys; bootstrap derives executed spend from the chain.

const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  const bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] << 8; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === '1') bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
const utf8 = (u8) => new TextDecoder().decode(u8);

class LedgerUnavailable extends Error {}

async function rpc(env, method, params) {
  const urls = [env.RPC_URL, 'https://solana-devnet.publicnode.com', 'https://api.devnet.solana.com'];
  let errs = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) trustlayer/0.1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) { errs.push(method + ' http ' + res.status + ' @ ' + u); continue; }
      const j = await res.json();
      if (j.error) { errs.push(method + ' rpc ' + JSON.stringify(j.error) + ' @ ' + u); continue; }
      return j.result;
    } catch (e) { errs.push(String(e) + ' @ ' + u); }
  }
  throw new LedgerUnavailable(errs.join(" | "));
}

// Executed spend = confirmed vault outflows carrying this policy's memo.
async function deriveExecutedSpendLamports(env, policyId, windowStartMs) {
  const sigs = await rpc(env, 'getSignaturesForAddress', [env.VAULT, { limit: 100 }]);
  let total = 0;
  for (const s of sigs) {
    if (s.err) continue;
    if (s.blockTime && s.blockTime * 1000 < windowStartMs) continue;
    const tx = await rpc(env, 'getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    if (!tx || !tx.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    const vIdx = keys.indexOf(env.VAULT);
    if (vIdx < 0) continue;
    const hasMemo = (tx.transaction.message.instructions || []).some(ix => {
      const pid = typeof ix.programId === 'string' ? ix.programId : keys[ix.programIdIndex];
      if (pid !== MEMO_PROGRAM_V1 && pid !== MEMO_PROGRAM_V2) return false;
      try { return utf8(b58decode(ix.data)).startsWith(`trustlayer:${policyId}:`); } catch { return false; }
    });
    if (!hasMemo) continue;
    const delta = tx.meta.preBalances[vIdx] - tx.meta.postBalances[vIdx];
    if (delta > 0) total += delta;
  }
  return total;
}

function evaluatePolicy(policy, tx, committedLamports) {
  const reasons = [];
  const amt = Number(tx.amountSol);
  const amtL = Math.round(amt * 1e9);
  const prog = String(tx.programId || '11111111111111111111111111111111');
  const action = String(tx.action || 'transfer');
  if (policy.expiresAt && Date.now() > new Date(policy.expiresAt).getTime())
    reasons.push(`policy expired at ${policy.expiresAt}`);
  if (policy.allowedActions?.length && !policy.allowedActions.includes(action))
    reasons.push(`action "${action}" not permitted by policy`);
  if (!(amt > 0)) reasons.push('invalid amount: ' + tx.amountSol);
  if (amtL > Math.round(policy.maxSolPerTransaction * 1e9))
    reasons.push(`amount ${amt} SOL exceeds per-transaction limit ${policy.maxSolPerTransaction} SOL`);
  if (policy.allowedPrograms?.length && !policy.allowedPrograms.includes(prog))
    reasons.push(`program ${prog} not permitted by policy`);
  if (policy.blockedDestinations?.includes(String(tx.destination)))
    reasons.push(`destination ${tx.destination} explicitly blocked by policy`);
  if (policy.allowedDestinations?.length && !policy.allowedDestinations.includes(String(tx.destination)))
    reasons.push(`destination ${tx.destination} not in policy allowlist`);
  if (committedLamports != null && committedLamports + amtL > Math.round(policy.maxSolTotal * 1e9))
    reasons.push('total budget would be exceeded');
  return { allow: reasons.length === 0, reasons };
}

// Durable Object: one per policyId. Single-writer: mutations run inside
// blockConcurrencyWhile so check+reserve is atomic across restarts/requests.
export class PolicyGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cache = null;
  }
  async load() {
    if (!this.cache) {
      this.cache = (await this.state.storage.get('gate')) || { executedLamports: 0, inflight: {}, audit: [], bootstrappedAt: null };
    }
  }
  committed() {
    let t = this.cache.executedLamports;
    for (const k of Object.keys(this.cache.inflight)) t += this.cache.inflight[k].lamports;
    return t;
  }
  async ensureBootstrap() {
    if (this.cache.bootstrappedAt) return null;
    try {
      const executed = await deriveExecutedSpendLamports(this.env, this.env.POLICY_ID, 0);
      this.cache.executedLamports = executed;
      this.cache.bootstrappedAt = new Date().toISOString();
      await this.state.storage.put('gate', this.cache);
      return null;
    } catch (e) { return String(e); }
  }
  async fetch(req) {
    const url = new URL(req.url);
    await this.load();
    if (url.pathname === '/bootstrap' || url.pathname === '/refresh') {
      return this.state.blockConcurrencyWhile(async () => {
        try {
          const executed = await deriveExecutedSpendLamports(this.env, this.env.POLICY_ID, 0);
          this.cache.executedLamports = executed;
          // drop inflight entries older than their TTL (crashed proposers)
          const now = Date.now();
          for (const k of Object.keys(this.cache.inflight))
            if (now > this.cache.inflight[k].expiresAt) delete this.cache.inflight[k];
          this.cache.bootstrappedAt = new Date().toISOString();
          await this.state.storage.put('gate', this.cache);
          return Response.json({ ok: true, executedLamports: executed });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 503 });
        }
      });
    }
    if (url.pathname === '/state') {
      return Response.json({ ...this.cache, committedLamports: this.cache ? this.committed() : null });
    }
    if (url.pathname === '/evaluate') {
      const tx = await req.json();
      return this.state.blockConcurrencyWhile(async () => {
        const bErr = await this.ensureBootstrap();
        if (bErr)
          return Response.json({ allow: false, reasons: ['ledger unavailable: ' + bErr], dryRun: true }, { status: 503 });
        const policy = JSON.parse(this.env.POLICY_JSON);
        const r = evaluatePolicy(policy, tx, this.committed());
        this.cache.audit.push({ ts: new Date().toISOString(), kind: 'evaluate', ...tx, decision: r.allow ? 'allowed' : 'rejected', reasons: r.reasons });
        if (this.cache.audit.length > 200) this.cache.audit = this.cache.audit.slice(-200);
        await this.state.storage.put('gate', this.cache);
        return Response.json({ ...r, policyVersion: policy.version, dryRun: true, signing: 'disabled-on-this-host' });
      });
    }
    if (url.pathname === '/propose') {
      const tx = await req.json();
      return this.state.blockConcurrencyWhile(async () => {
        const bErr = await this.ensureBootstrap();
        if (bErr)
          return Response.json({ ok: false, error: 'ledger unavailable: ' + bErr }, { status: 503 });
        const policy = JSON.parse(this.env.POLICY_JSON);
        const r = evaluatePolicy(policy, tx, this.committed());
        if (!r.allow) return Response.json({ ok: false, reasons: r.reasons }, { status: 403 });
        const authId = tx.authId || 'anon';
        if (this.cache.inflight[authId]) return Response.json({ ok: false, reasons: ['replay: authorization already in flight'] }, { status: 409 });
        this.cache.inflight[authId] = { lamports: Math.round(Number(tx.amountSol) * 1e9), expiresAt: Date.now() + 120000 };
        this.cache.audit.push({ ts: new Date().toISOString(), kind: 'reserve', authId, amountSol: tx.amountSol, note: 'signing disabled on this host; reservation only' });
        await this.state.storage.put('gate', this.cache);
        return Response.json({ ok: true, reserved: true, authId, signing: 'disabled-on-this-host', note: 'reservation recorded for durable-gate validation; no funds move' });
      });
    }
    return new Response('not found', { status: 404 });
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-trustlayer-key',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const gate = () => env.POLICY_GATE.get(env.POLICY_GATE.idFromName(env.POLICY_ID));
    try {
      if (url.pathname === '/api/health')
        return Response.json({ ok: true, service: 'trustlayer-api', host: 'cloudflare-worker', time: new Date().toISOString(), readOnly: true }, { headers: CORS });
      if (url.pathname === '/api/policies' && req.method === 'GET') {
        const p = JSON.parse(env.POLICY_JSON);
        const { blockedDestinations, ...rest } = p;
        return Response.json({ ...rest, blockedDestinations }, { headers: CORS });
      }
      if (url.pathname === '/api/audit') {
        const s = await gate().fetch(new Request('https://do/state'));
        const g = await s.json();
        return Response.json({ entries: g.audit || [], note: 'audit entries persist in a Durable Object (survive redeploys); executed spend is derived from on-chain history', bootstrappedAt: g.bootstrappedAt }, { headers: CORS });
      }
      if (url.pathname === '/api/gate/state') {
        const s = await gate().fetch(new Request('https://do/state'));
        return new Response(s.body, { headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/gate/bootstrap' && req.method === 'POST') {
        const s = await gate().fetch(new Request('https://do/bootstrap', { method: 'POST' }));
        return new Response(s.body, { status: s.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/evaluate' && req.method === 'POST') {
        const s = await gate().fetch(new Request('https://do/evaluate', { method: 'POST', body: await req.text() }));
        return new Response(s.body, { status: s.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/propose' && req.method === 'POST') {
        const s = await gate().fetch(new Request('https://do/propose', { method: 'POST', body: await req.text() }));
        return new Response(s.body, { status: s.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/policies' && req.method === 'PUT')
        return Response.json({ error: 'policy updates disabled on this host' }, { status: 503, headers: CORS });
      return new Response('not found', { status: 404, headers: CORS });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500, headers: CORS });
    }
  },
};
