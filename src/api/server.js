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

const PORT = process.env.PORT || 8787;
const { policy } = loadPolicy();
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
  if (req.method === 'GET' && url.pathname === '/api/audit')
    return json(res, 200, { entries: audit.recent(100) });
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

server.listen(PORT, () => console.log(`TrustLayer API on http://localhost:${PORT}`));
