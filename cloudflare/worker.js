import { groqChat, GROQ_MODEL } from './groq.js';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
// TrustLayer API — Cloudflare Worker (read-only parity + durable gate prototype)
// Policy evaluation + on-chain-derived budget checks; signing DISABLED on this host.
// Durable Object PolicyGate: single-writer serializable reservation state that
// survives restarts/redeploys; bootstrap derives executed spend from the chain.

const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  const bytes = [];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry = bytes[i] * 58 + carry; bytes[i] = carry & 0xff; carry >>= 8; }
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
      for (let attempt = 0; attempt < 4; attempt++) {
        const j = await res.json().catch(() => null);
        if (j && !j.error) return j.result;
        const msg = j && j.error ? JSON.stringify(j.error) : ('http ' + res.status);
        errs.push(method + ' rpc ' + msg + ' @ ' + u);
        const transient = j && j.error && (j.error.code === 429 || /too many/i.test(j.error.message || ''));
        if (!transient) break;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    } catch (e) { errs.push(String(e) + ' @ ' + u); }
  }
  throw new LedgerUnavailable(errs.join(" | "));
}

// Executed spend = confirmed vault outflows carrying this policy's memo.
async function deriveExecutedState(env, policyId, windowStartMs, checkpoint) {
  const src = env.VAULT || env.GATE_WALLET; // squads era: spend truth is the multisig vault
  // incremental: only fetch signatures newer than the last processed one
  const opts = { limit: 50 };
  if (checkpoint) opts.until = checkpoint;
  const sigs = await rpc(env, 'getSignaturesForAddress', [src, opts]);
  let total = 0; const authIds = new Set();
  const newest = sigs.length ? sigs[0].signature : checkpoint;
  for (const s of sigs) {
    if (s.err) continue;
    if (checkpoint && s.signature === checkpoint) break;
    if (s.blockTime && s.blockTime * 1000 < windowStartMs) continue;
    const tx = await rpc(env, 'getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    if (!tx || !tx.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    const la = (tx.meta && tx.meta.loadedAddresses) || {};
    const allKeys = keys.concat(la.writable || [], la.readonly || []);
    const vIdx = allKeys.indexOf(src);
    if (vIdx < 0) continue;
    let memoAuth = null;
    const allIxs = [...(tx.transaction.message.instructions || []), ...((tx.meta.innerInstructions || []).flatMap(g => g.instructions || []))];
    const hasMemo = allIxs.some(ix => {
      const pid = typeof ix.programId === 'string' ? ix.programId : allKeys[ix.programIdIndex];
      if (pid !== MEMO_PROGRAM_V1 && pid !== MEMO_PROGRAM_V2) return false;
      try {
        const m = utf8(b58decode(ix.data));
        if (m.startsWith(`trustlayer:${policyId}:`)) { const p = m.split(':'); memoAuth = p[3] || null; return true; }
      } catch {}
      return false;
    });
    if (!hasMemo) continue;
    if (memoAuth) authIds.add(memoAuth);
    const delta = tx.meta.preBalances[vIdx] - tx.meta.postBalances[vIdx];
    if (delta > 0) total += delta;
  }
  return { lamports: total, authIds, checkpoint: newest };
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
  async pruneExpiredInflight() {
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(this.cache.inflight || {})) {
      const e = this.cache.inflight[k];
      // squads proposals (txIndex set) never TTL-expire: they stay reserved until the
      // chain authoritatively shows execution (memo-derived) - fail closed otherwise
      if (e.txIndex != null) continue;
      if (now > e.expiresAt) {
        // Ambiguous: the DO may have lost the post-proposal write (reset mid-call).
        // Probe the FULL on-chain index range for this authorization's memo before
        // releasing; only a complete scan without a match releases. Any gap (RPC
        // error, history beyond the scan cap) fails closed and keeps it reserved.
        const policy = JSON.parse(this.env.POLICY_JSON);
        const memo = `trustlayer:${this.env.POLICY_ID}:v${policy.version}:${k}`;
        let found = null;
        try { found = await findProposalByMemo(this.env, memo); }
        catch { continue; } // probe inconclusive: fail closed, keep the reservation
        if (found != null) {
          e.txIndex = found; e.expiresAt = null; e.status = 'pending-gatekeeper';
          this.cache.audit.push({ ts: new Date().toISOString(), kind: 'reservation-recovered', authId: k, txIndex: found, note: 'TTL expired but the chain shows this proposal; held until execution or operator cancel after on-chain rejection' });
        } else {
          delete this.cache.inflight[k];
        }
        changed = true;
      }
    }
    return changed;
  }
  async ensureBootstrap() {
    if (this.cache.bootstrappedAt) return null;
    try {
      const st = await deriveExecutedState(this.env, this.env.POLICY_ID, 0, this.cache.ledgerCheckpoint || null);
      // cumulative: checkpointed derivation only scans signatures newer than the last processed one
      this.cache.executedLamports = (this.cache.executedLamports || 0) + st.lamports;
      this.cache.usedAuthIds = [...new Set([...(this.cache.usedAuthIds || []), ...st.authIds])];
      this.cache.ledgerCheckpoint = st.checkpoint || this.cache.ledgerCheckpoint || null;
      for (const k of Object.keys(this.cache.inflight || {}))
        if ((this.cache.usedAuthIds || []).includes(k)) delete this.cache.inflight[k];
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
          // incremental authoritative re-derivation from chain memos
          const st = await deriveExecutedState(this.env, this.env.POLICY_ID, 0, this.cache.ledgerCheckpoint || null);
          this.cache.executedLamports = (this.cache.executedLamports || 0) + st.lamports;
          this.cache.usedAuthIds = [...new Set([...(this.cache.usedAuthIds || []), ...st.authIds])];
          this.cache.ledgerCheckpoint = st.checkpoint || this.cache.ledgerCheckpoint || null;
          // clear inflight reservations the chain shows as executed; never TTL-release squads entries
          for (const k of Object.keys(this.cache.inflight || {}))
            if ((this.cache.usedAuthIds || []).includes(k)) delete this.cache.inflight[k];
          await this.pruneExpiredInflight();
          this.cache.bootstrappedAt = new Date().toISOString();
          await this.state.storage.put('gate', this.cache);
          return Response.json({ ok: true, executedLamports: this.cache.executedLamports, usedAuthIds: this.cache.usedAuthIds });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 503 });
        }
      });
    }
    if (url.pathname === '/cancel' && req.method === 'POST') {
      return this.state.blockConcurrencyWhile(async () => {
        const body = await req.json();
        const authId = String((body && body.authId) || '');
        const e = (this.cache.inflight || {})[authId];
        if (!e) return Response.json({ ok: false, error: 'no pending reservation for authId' }, { status: 404 });
        if ((this.cache.usedAuthIds || []).includes(authId))
          return Response.json({ ok: false, error: 'authId already executed on chain; refusing release' }, { status: 409 });
        delete this.cache.inflight[authId];
        this.cache.audit.push({ ts: new Date().toISOString(), kind: 'reservation-cancelled', authId, txIndex: e.txIndex ?? null, note: 'admin release; caller asserts proposal rejected/cancelled on chain' });
        await this.state.storage.put('gate', this.cache);
        return Response.json({ ok: true, released: authId });
      });
    }
    // Durable global daily cap for the PUBLIC, non-executing AI interpretation lane.
    // 100 interpretations/day = at most 200 model calls/day, well under the Groq
    // free plan's 1K requests/day for openai/gpt-oss-20b. Single-writer DO = exact.
    if (url.pathname === '/agent-quota' && req.method === 'POST') {
      return this.state.blockConcurrencyWhile(async () => {
        const CAP = 100;
        const day = new Date().toISOString().slice(0, 10);
        if (this.cache.aiQuotaDay !== day) { this.cache.aiQuotaDay = day; this.cache.aiQuotaUsed = 0; }
        const allowed = (this.cache.aiQuotaUsed || 0) < CAP;
        if (allowed) this.cache.aiQuotaUsed = (this.cache.aiQuotaUsed || 0) + 1;
        await this.state.storage.put('gate', this.cache);
        return Response.json({ allowed, used: this.cache.aiQuotaUsed, cap: CAP, day });
      });
    }
    if (url.pathname === '/agent' && req.method === 'POST') {
      return this.state.blockConcurrencyWhile(async () => {
        // AI task interpretation (PRD AI scope): an LLM parses a natural-language
        // task into a payment proposal; the DETERMINISTIC policy engine decides;
        // the LLM then explains the verdict. The LLM can never approve, execute,
        // or override - this route creates no reservation and moves no funds.
        const ip = req.headers.get('x-client-ip') || 'unknown';
        const now = Date.now();
        this.cache.aiRate = this.cache.aiRate || {};
        const rec = (this.cache.aiRate[ip] || []).filter(t => now - t < 3600000);
        if (rec.length >= 30)
          return Response.json({ ok: false, error: 'rate limit: 30 AI interpretations per hour per IP' }, { status: 429 });
        rec.push(now); this.cache.aiRate[ip] = rec;
        const ips = Object.keys(this.cache.aiRate);
        if (ips.length > 200) this.cache.aiRate = { [ip]: rec };
        const body = await req.json().catch(() => null);
        const task = String((body && body.task) || '').slice(0, 500).trim();
        if (!task) return Response.json({ ok: false, error: 'task (string) required' }, { status: 400 });
        const policy = JSON.parse(this.env.POLICY_JSON);
        const vendorA = (policy.allowedDestinations || [])[0] || '';
        const NOTE = 'AI interprets the task and explains the verdict; the deterministic policy engine decides. AI output can never approve a payment. No execution or reservation happens on this route.';
        let proposal = null, aiError = null;
        try {
          const r1 = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { max_tokens: 128, messages: [
            { role: 'system', content: 'You convert a payment task into JSON. Known recipient name: "Vendor A" = ' + vendorA + '. Reply with ONLY a JSON object: {"destination":"<base58 address>","amountSol":<number>} - or {"error":"why"} if the task is not a clear SOL payment. Never invent an address; use only an address present in this prompt or literally given in the task.' },
            { role: 'user', content: task },
          ] });
          const text = String((r1 && r1.response) || '');
          const m = text.match(/\{[\s\S]*\}/);
          if (m) proposal = JSON.parse(m[0]); else aiError = 'model returned no JSON';
        } catch (e) { aiError = String(e); }
        if (aiError || !proposal || proposal.error) {
          const err = (proposal && proposal.error) || aiError || 'could not interpret task';
          this.cache.audit.push({ ts: new Date().toISOString(), kind: 'ai-interpret', task: task.slice(0, 120), decision: 'unparseable', error: String(err).slice(0, 200) });
          await this.state.storage.put('gate', this.cache);
          return Response.json({ ok: false, stage: 'interpret', error: err, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', note: NOTE }, { status: 422 });
        }
        const tx = { destination: String(proposal.destination || ''), amountSol: Number(proposal.amountSol) };
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx.destination) || !Number.isFinite(tx.amountSol) || !Number.isSafeInteger(Math.round(tx.amountSol * 1e9)) || !(tx.amountSol > 0)) {
          this.cache.audit.push({ ts: new Date().toISOString(), kind: 'ai-interpret', task: task.slice(0, 120), decision: 'invalid-proposal', proposal: tx });
          await this.state.storage.put('gate', this.cache);
          return Response.json({ ok: false, stage: 'validate', error: 'AI proposal failed shape validation (destination/amount)', proposal: tx, note: NOTE }, { status: 422 });
        }
        await this.pruneExpiredInflight();
        const bErr = await this.ensureBootstrap();
        if (bErr) return Response.json({ ok: false, error: 'ledger unavailable: ' + bErr }, { status: 503 });
        const r = evaluatePolicy(policy, tx, this.committed());
        let explanation = null;
        try {
          const r2 = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { max_tokens: 96, messages: [
            { role: 'system', content: 'Explain a payment policy verdict in at most 2 short sentences. The verdict is final, made by deterministic rules - never contradict or soften it.' },
            { role: 'user', content: 'Verdict: ' + (r.allow ? 'ALLOWED' : 'BLOCKED') + '. Reasons: ' + (r.reasons.join('; ') || 'every policy check passed') + '. Payment requested: ' + tx.amountSol + ' SOL to ' + tx.destination + '.' },
          ] });
          explanation = String((r2 && r2.response) || '').trim() || null;
        } catch (e) {}
        this.cache.audit.push({ ts: new Date().toISOString(), kind: 'ai-interpret', task: task.slice(0, 120), proposal: tx, decision: r.allow ? 'allowed' : 'rejected', reasons: r.reasons });
        if (this.cache.audit.length > 200) this.cache.audit = this.cache.audit.slice(-200);
        await this.state.storage.put('gate', this.cache);
        return Response.json({ ok: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task, proposal: tx, verdict: { allow: r.allow, reasons: r.reasons }, explanation, note: NOTE });
      });
    }
    if (url.pathname === '/state') {
      return Response.json({ ...this.cache, committedLamports: this.cache ? this.committed() : null });
    }
    if (url.pathname === '/evaluate') {
      const tx = await req.json();
      return this.state.blockConcurrencyWhile(async () => {
        await this.pruneExpiredInflight();
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
        await this.pruneExpiredInflight();
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
    if (url.pathname === '/execute' && req.method === 'POST') {
      const tx = await req.json();
      return this.state.blockConcurrencyWhile(async () => {
        await this.pruneExpiredInflight();
        if (!this.env.AGENT_SECRET || !this.env.RELAY_KEY)
          return Response.json({ ok: false, reasons: ['signing not provisioned on this host'], signing: 'disabled' }, { status: 503 });
        const bErr = await this.ensureBootstrap();
        if (bErr)
          return Response.json({ ok: false, reasons: ['ledger unavailable: ' + bErr], signing: 'fail-closed' }, { status: 503 });
        const policy = JSON.parse(this.env.POLICY_JSON);
        const r = evaluatePolicy(policy, tx, this.committed());
        if (!r.allow) return Response.json({ ok: false, reasons: r.reasons }, { status: 403 });
        const authId = String(tx.authId || '');
        if (!authId || authId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(authId))
          return Response.json({ ok: false, reasons: ['authId required (<=64 chars, A-Za-z0-9_-)'] }, { status: 400 });
        if ((this.cache.usedAuthIds || []).includes(authId) || this.cache.inflight[authId])
          return Response.json({ ok: false, reasons: ['replay: authorization already executed or in flight'] }, { status: 409 });
        const lamports = Math.round(Number(tx.amountSol) * 1e9);
        this.cache.inflight[authId] = { lamports, expiresAt: Date.now() + 120000 };
        await this.state.storage.put('gate', this.cache);
        // build, sign, send — any failure leaves the inflight reservation until TTL or chain-derived truth
        const memo = `trustlayer:${this.env.POLICY_ID}:v${policy.version}:${authId}`;
        // Squads 2-of-2: agent key only creates the vault transaction + proposal and approves 1/2.
        // No funds move here; execution requires the independent gatekeeper signature.
        const txIndexNum = this.cache.nextTxIndex || Number(this.env.TX_INDEX_SEED || 0) || 1;
        let proposed;
        try {
          proposed = await squadsPropose(this.env, String(tx.destination), lamports, memo, txIndexNum);
        } catch (e) {
          delete this.cache.inflight[authId];
          this.cache.audit.push({ ts: new Date().toISOString(), kind: 'propose-failed', authId, error: String(e).slice(0, 300) });
          await this.state.storage.put('gate', this.cache);
          return Response.json({ ok: false, reasons: ['proposal submission failed: ' + String(e).slice(0, 200)], authId, status: 'failed-no-funds-moved' }, { status: 502 });
        }
        // hold the reservation until the chain shows execution (memo-derived) or the proposal window lapses
        this.cache.nextTxIndex = Number(proposed.transactionIndex) + 1;
        this.cache.inflight[authId] = { lamports, expiresAt: null, txIndex: proposed.transactionIndex, status: 'pending-gatekeeper' };
        this.cache.bootstrappedAt = null; // force chain re-derivation on next request
        this.cache.audit.push({ ts: new Date().toISOString(), kind: 'proposed', authId, amountSol: tx.amountSol, destination: tx.destination, txIndex: proposed.transactionIndex, sigs: proposed.sigs, memo });
        await this.state.storage.put('gate', this.cache);
        return Response.json({ ok: true, status: 'proposed-awaiting-gatekeeper', authId, transactionIndex: proposed.transactionIndex, sigs: proposed.sigs, memo, multisig: this.env.MULTISIG, vault: this.env.VAULT, note: 'agent approved 1-of-2; funds have NOT moved; execution requires the gatekeeper signature (2-of-2)' }, { status: 202 });
      });
    }
    if (url.pathname === '/state')
      return Response.json({ executedLamports: this.cache.executedLamports || 0, usedAuthIds: this.cache.usedAuthIds || [], inflight: this.cache.inflight || {}, bootstrappedAt: this.cache.bootstrappedAt, ledgerCheckpoint: this.cache.ledgerCheckpoint || null });
    return new Response('not found', { status: 404 });
  }
}

// ---- hosted signing (devnet only; agent hot wallet; policy-gated) ----
const B58E = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let s = ''; const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  for (const b of bytes) { if (b === 0) s += '1'; else break; }
  return s + digits.reverse().map(d => B58E[d]).join('');
}
const cu16 = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n >>= 7; } out.push(n); return new Uint8Array(out); };
const cat = (...arrs) => { const t = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0)); let o = 0; for (const a of arrs) { t.set(a, o); o += a.length; } return t; };
const u32le = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);
const u64le = (n) => { const a = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { a[i] = Number(v & 255n); v >>= 8n; } return a; };

async function signAndSend(env, dest, lamports, memo) {
  const secret = b58decode(env.AGENT_SECRET.trim());
  const from = env.GATE_WALLET || env.VAULT;
  const bh = await rpc(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = b58decode(bh.value.blockhash);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8FromRaw(secret), { name: 'Ed25519' }, false, ['sign']);
  const fromB = b58decode(from), destB = b58decode(dest);
  const SYS = b58decode('11111111111111111111111111111111');
  const MEMO = b58decode(MEMO_PROGRAM_V2);
  // accounts: [from(signer,writable), dest(writable), system, memo]
  const keys = [fromB, destB, SYS, MEMO];
  const ixTransfer = cat([2], cu16(2), [0, 1], cu16(12), cat(u32le(2), u64le(lamports))); // program idx 2, 2 accts [0,1], data len 12
  const memoBytes = new TextEncoder().encode(memo);
  const ixMemo = cat([3], cu16(1), [0], cu16(memoBytes.length), memoBytes); // program idx 3, 1 acct [0]
  const msg = cat(
    [1, 0, 2], // header: 1 signer, 0 ro-signed, 2 ro-unsigned
    cu16(4), ...keys,
    blockhash,
    cu16(2), ixTransfer, ixMemo
  );
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, msg));
  const rawTx = cat(cu16(1), signature, msg);
  const b64 = btoa(String.fromCharCode(...rawTx));
  const urls = [env.RPC_URL];
  let lastErr = 'no rpc';
  for (const u of urls) {
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-key': env.RELAY_KEY }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }] }) });
      const j = await res.json();
      if (j.error) { lastErr = JSON.stringify(j.error).slice(0, 300); continue; }
      return j.result;
    } catch (e) { lastErr = String(e); }
  }
  throw new Error('sendTransaction failed: ' + lastErr);
}
function squadsConn(env) {
  return new Connection(env.RPC_URL, { commitment: 'confirmed', fetch: (url, opts) => { opts.headers['x-relay-key'] = env.RELAY_KEY; return fetch(url, opts); } });
}
// Authoritative chain probe for an ambiguous reservation: did a vault transaction
// carrying this exact authorization memo land on-chain? Scans the FULL index range
// (1..last), so absence is authoritative. Throws - and the caller fails closed
// (keeps the reservation) - on RPC errors or when the range exceeds the scan cap,
// because an incomplete scan cannot prove absence.
async function findProposalByMemo(env, memo, scanCap = 200) {
  const conn = squadsConn(env);
  const multisigPda = new PublicKey(env.MULTISIG);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const last = Number(ms.transactionIndex.toString());
  if (last > scanCap) throw new Error('multisig history exceeds scan cap; inconclusive');
  const MEMO = new PublicKey(MEMO_PROGRAM_V2);
  for (let i = last; i >= 1; i--) {
    const [pda] = multisig.getTransactionPda({ multisigPda, index: BigInt(i) });
    let vtx = null;
    try { vtx = await multisig.accounts.VaultTransaction.fromAccountAddress(conn, pda); } catch { continue; }
    const keys = vtx.message.accountKeys;
    for (const ix of vtx.message.instructions) {
      if (keys[ix.programIdIndex].equals(MEMO) && Buffer.from(ix.data).toString('utf8') === memo) return i;
    }
  }
  return null;
}
async function squadsPropose(env, dest, lamports, memoText, txIndexNum) {
  const conn = squadsConn(env);
  const agent = Keypair.fromSecretKey(b58decode(env.AGENT_SECRET.trim()));
  const multisigPda = new PublicKey(env.MULTISIG);
  const vaultPda = new PublicKey(env.VAULT);
  // txIndex is DO-tracked (single writer), floored from the chain so a DO reset
  // can never reuse an index that already exists on-chain
  let transactionIndex = BigInt(txIndexNum);
  try {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
    const chainNext = BigInt(ms.transactionIndex.toString()) + 1n;
    if (chainNext > transactionIndex) transactionIndex = chainNext;
  } catch {}
  const bh = async () => (await conn.getLatestBlockhash('confirmed')).blockhash;
  const innerMsg = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: await bh(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(dest), lamports }),
      { programId: new PublicKey(MEMO_PROGRAM_V2), keys: [], data: new TextEncoder().encode(memoText) },
    ],
  });
  const send = async (tx) => {
    tx.sign([agent]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    // wait for confirmation: squads validates each step against confirmed chain state
    for (let i = 0; i < 20; i++) {
      const st = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
      if (st) {
        if (st.meta && st.meta.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.meta.err).slice(0, 150));
        return sig;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('confirmation timeout: ' + sig);
  };
  const sigCreate = await send(multisig.transactions.vaultTransactionCreate({ blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, creator: agent.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: innerMsg, memo: memoText.slice(0, 60) }));
  const sigPropose = await send(multisig.transactions.proposalCreate({ blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, creator: agent.publicKey }));
  const sigApprove = await send(multisig.transactions.proposalApprove({ blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, member: agent.publicKey }));
  return { transactionIndex: Number(transactionIndex), sigs: { sigCreate, sigPropose, sigApprove } };
}

function pkcs8FromRaw(secret64) {
  // ed25519 pkcs8 prefix + 32-byte seed (first half of the 64-byte secret key)
  const prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  return cat(prefix, secret64.slice(0, 32));
}
async function confirmSig(env, sig, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc(env, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
    const st = r && r.value && r.value[0];
    if (st) {
      if (st.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.err));
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return true;
    }
    await new Promise(r2 => setTimeout(r2, 2000));
  }
  return false;
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
      if (url.pathname === '/api/agent' && req.method === 'POST') {
        const isOperator = env.API_KEY && req.headers.get('x-trustlayer-key') === env.API_KEY;
        // Public lane (no operator key): interpretation only - creates no reservation,
        // moves no funds. Durable global daily cap enforced in the DO; per-IP hourly
        // cap below; Groq 429/error fails closed with no retry and no fallback.
        if (!isOperator) {
          const q = await gate().fetch(new Request('https://do/agent-quota', { method: 'POST' }));
          const qj = await q.json().catch(() => null);
          if (!qj || qj.allowed !== true)
            return Response.json({ ok: false, error: 'daily public AI interpretation quota reached (' + ((qj && qj.cap) || 100) + '/day); try again tomorrow or ask the operator', quota: qj || null }, { status: 429, headers: { ...CORS, 'content-type': 'application/json' } });
        }
        // AI task interpretation (PRD Module 7), handled in the stateless worker so it
        // always runs the latest deployed code: the LLM interprets the task, the
        // DETERMINISTIC policy engine in the Durable Object decides, the LLM explains
        // the verdict. The LLM can never approve, execute, or override - this route
        // creates no reservation and moves no funds.
        const NOTE = 'AI interprets the task and explains the verdict; the deterministic policy engine decides. AI output can never approve a payment. No execution or reservation happens on this route.';
        const MODEL = GROQ_MODEL;
        const ip = req.headers.get('cf-connecting-ip') || 'unknown';
        const now = Date.now();
        globalThis.__aiRate = globalThis.__aiRate || {};
        const rec = (globalThis.__aiRate[ip] || []).filter(t => now - t < 3600000);
        if (rec.length >= 30)
          return Response.json({ ok: false, error: 'rate limit: 30 AI interpretations per hour per IP (best-effort, per isolate)' }, { status: 429, headers: { ...CORS, 'content-type': 'application/json' } });
        rec.push(now); globalThis.__aiRate[ip] = rec;
        const body = await req.json().catch(() => null);
        const task = String((body && body.task) || '').slice(0, 500).trim();
        if (!task) return Response.json({ ok: false, error: 'task (string) required' }, { status: 400, headers: { ...CORS, 'content-type': 'application/json' } });
        const policy = JSON.parse(env.POLICY_JSON);
        const vendorA = (policy.allowedDestinations || [])[0] || '';
        let proposal = null, aiError = null;
        try {
          const r1 = await groqChat(env, { json: true, max_tokens: 512, messages: [
            { role: 'system', content: 'You convert a payment task into JSON. Known recipient name: "Vendor A" = ' + vendorA + '. Reply with ONLY a JSON object: {"destination":"<base58 address>","amountSol":<number>} - or {"error":"why"} if the task is not a clear SOL payment. Never invent an address; use only an address present in this prompt or literally given in the task.' },
            { role: 'user', content: task },
          ] });
          const rawResp = r1 && r1.response; const text = typeof rawResp === 'string' ? rawResp : JSON.stringify(rawResp !== undefined ? rawResp : r1).slice(0, 400);
          const m = text.match(/\{[\s\S]*\}/);
          if (m) proposal = JSON.parse(m[0]); else aiError = 'model returned no JSON: ' + text.slice(0, 200);
        } catch (e) { aiError = String(e); }
        if (aiError || !proposal || proposal.error) {
          const err = (proposal && proposal.error) || aiError || 'could not interpret task';
          return Response.json({ ok: false, stage: 'interpret', error: err, model: MODEL, note: NOTE }, { status: 422, headers: { ...CORS, 'content-type': 'application/json' } });
        }
        const tx = { destination: String(proposal.destination || ''), amountSol: Number(proposal.amountSol) };
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx.destination) || !Number.isFinite(tx.amountSol) || !Number.isSafeInteger(Math.round(tx.amountSol * 1e9)) || !(tx.amountSol > 0))
          return Response.json({ ok: false, stage: 'validate', error: 'AI proposal failed shape validation (destination/amount)', proposal: tx, note: NOTE }, { status: 422, headers: { ...CORS, 'content-type': 'application/json' } });
        const ev = await gate().fetch(new Request('https://do/evaluate', { method: 'POST', body: JSON.stringify(tx) }));
        const verdict = await ev.json().catch(() => null);
        if (!verdict || typeof verdict.allow !== 'boolean')
          return Response.json({ ok: false, stage: 'policy', error: 'policy engine unavailable', note: NOTE }, { status: 503, headers: { ...CORS, 'content-type': 'application/json' } });
        let explanation = null;
        try {
          const r2 = await groqChat(env, { max_tokens: 256, messages: [
            { role: 'system', content: 'Explain a payment policy verdict in at most 2 short sentences. The verdict is final, made by deterministic rules - never contradict or soften it.' },
            { role: 'user', content: 'Verdict: ' + (verdict.allow ? 'ALLOWED' : 'BLOCKED') + '. Reasons: ' + ((verdict.reasons || []).join('; ') || 'every policy check passed') + '. Payment requested: ' + tx.amountSol + ' SOL to ' + tx.destination + '.' },
          ] });
          explanation = String((r2 && r2.response) || '').trim() || null;
        } catch (e) {}
        return Response.json({ ok: true, model: MODEL, task, proposal: tx, verdict: { allow: verdict.allow, reasons: verdict.reasons || [] }, explanation, note: NOTE }, { headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/evaluate' && req.method === 'POST') {
        const s = await gate().fetch(new Request('https://do/evaluate', { method: 'POST', body: await req.text() }));
        return new Response(s.body, { status: s.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if ((url.pathname === '/api/execute' || url.pathname === '/api/propose') && req.method === 'POST') {
        const k = req.headers.get('x-trustlayer-key') || '';
        if (!env.API_KEY || k !== env.API_KEY)
          return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
      }
      if (url.pathname === '/api/cancel' && req.method === 'POST') {
        const k = req.headers.get('x-trustlayer-key') || '';
        if (!env.API_KEY || k !== env.API_KEY)
          return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS });
        const body = await req.json();
        return gate().fetch(new Request('https://do/cancel', { method: 'POST', body: JSON.stringify(body) }));
      }
      if (url.pathname === '/api/execute' && req.method === 'POST') {
        const s = await gate().fetch(new Request('https://do/execute', { method: 'POST', body: await req.text() }));
        return new Response(s.body, { status: s.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/state') {
        const s = await gate().fetch(new Request('https://do/state'));
        return new Response(s.body, {status:s.status,headers:{...CORS,'content-type':'application/json'}});
      }
      if (url.pathname === '/api/refresh')
        return gate().fetch(new Request('https://do/refresh'));
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
