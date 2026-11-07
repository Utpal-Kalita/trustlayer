// TrustLayer backend API + static dashboard host (node:http, no extra deps).
// Endpoints:
//   GET  /api/health
//   GET  /api/policies
//   POST /api/evaluate   { destination, amountSol, programId? } -> policy decision
//   GET  /api/audit
//   POST /api/propose    -> runs Squads proposal flow when funded (scripts/spike covers demo)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, evaluate, AuditLog } from '../policy/engine.js';
import { loadKeys, loadState, runProposal } from '../onchain.js';
import { Connection } from '@solana/web3.js';

const PORT = process.env.PORT || 8787;
let { policy } = loadPolicy();
const audit = new AuditLog();

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/health')
    return json(res, 200, { ok: true, service: 'trustlayer-api', time: new Date().toISOString() });
  if (req.method === 'GET' && url.pathname === '/api/policies')
    return json(res, 200, policy);
  if (req.method === 'PUT' && url.pathname === '/api/policies') {
    // Policy rewrite = owner-level authority (it can re-authorize consumed
    // transactions by bumping the version), so it requires the same key as
    // the signing endpoint. Keys never leave this process.
    if (req.headers['x-trustlayer-key'] !== process.env.TRUSTLAYER_API_KEY)
      return json(res, 401, { error: 'missing or invalid x-trustlayer-key' });
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !(body.maxSolPerTransaction > 0))
      return json(res, 400, { error: 'invalid policy: maxSolPerTransaction must be positive' });
    fs.writeFileSync(path.resolve(process.cwd(), 'policies/default.json'), JSON.stringify(body, null, 2) + '\n');
    policy = loadPolicy().policy;
    audit.record({ kind: 'policy-update', decision: 'allowed', reasons: [], version: policy.version });
    return json(res, 200, { ok: true, policy });
  }
  if (req.method === 'GET' && url.pathname === '/api/audit')
    return json(res, 200, { entries: audit.recent(100) });
  // Full on-chain flow: evaluate -> 2-of-2 approval -> execute. Needs SOLANA_RPC
  // reachable (local validator or funded devnet) and .env keypairs present.
  if (req.method === 'POST' && url.pathname === '/api/propose') {
    // Signing endpoint: requires the shared API key. Keys never leave this process.
    const apiKey = process.env.TRUSTLAYER_API_KEY;
    if (!apiKey) return json(res, 503, { error: 'propose disabled: set TRUSTLAYER_API_KEY in the server environment' });
    if (req.headers['x-trustlayer-key'] !== apiKey) return json(res, 401, { error: 'missing or invalid x-trustlayer-key' });
    const tx = await readBody(req);
    try {
      const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
      const keys = loadKeys();
      const state = loadState();
      const result = await runProposal(conn, keys, state, audit, { destination: tx.destination, amountSol: Number(tx.amountSol), nonce: tx.nonce });
      return json(res, 200, { allow: result.decision.allow, reasons: result.decision.reasons, sig: result.sig || null, multisig: result.multisig || null });
    } catch (e) {
      return json(res, 502, { error: 'on-chain flow failed', detail: String(e).slice(0, 300) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/evaluate') {
    const tx = await readBody(req);
    const decision = evaluate(policy, tx, audit);
    audit.record({ kind: 'evaluate', ...tx, decision: decision.allow ? 'allowed' : 'rejected', reasons: decision.reasons });
    return json(res, 200, decision);
  }
  // static dashboard
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fp = path.resolve(process.cwd(), 'dashboard', rel);
  if (req.method === 'GET' && fp.startsWith(path.resolve(process.cwd(), 'dashboard')) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
    res.writeHead(200, { 'content-type': types[path.extname(fp)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(fp));
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`TrustLayer API on http://${process.env.HOST || '127.0.0.1'}:${PORT}`));
