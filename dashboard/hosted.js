// Hosted mode: the console reads the live, verified Cloudflare backend.
// Public routes only (docs/INTEGRATION.md): health, policies, state, audit, evaluate.
// The browser never holds x-trustlayer-key or any keypair, and nothing here can
// create a proposal or move funds. Real execution is owner-run:
//   hosted agent proposes + approves 1 of 2  ->  owner runs scripts/gatekeeper-execute.mjs (2 of 2).
export const WORKER = 'https://trustlayer-api-cf.adzeo2.workers.dev';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sol = (l) => `${+(Number(l || 0) / 1e9).toFixed(9)} SOL`;
const solN = (n) => `${+Number(n || 0).toFixed(9)} SOL`;
const short = (a) => a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '—');
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? `${Math.max(1, s | 0)}s ago` : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : new Date(iso).toLocaleDateString(); };
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${encodeURIComponent(id)}?cluster=devnet`;
const MULTISIG = 'BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC';
const VAULT = '93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe';

const H = { policy: null, state: null, audit: [], health: null, filter: 'all' };

async function get(path) {
  const r = await fetch(WORKER + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function evaluate(destination, amountSol) {
  const r = await fetch(WORKER + '/api/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination, amountSol }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !d.reasons) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const label = (addr) => {
  if (H.policy?.allowedDestinations?.[0] === addr) return 'Vendor A';
  if (H.policy?.blockedDestinations?.includes(addr)) return 'Blocked wallet';
  return null;
};
const who = (addr) => { const l = label(addr); return l ? `${esc(l)} <span class="mono muted small">${esc(short(addr))}</span>` : `<span class="mono">${esc(short(addr))}</span>`; };

// The worker returns reasons only; map them onto the policy's rules so the
// console shows every rule that ran, with the worker's own wording for failures.
function checksFor(d, amountSol, destination) {
  const p = H.policy || {};
  const rs = d.reasons || [];
  const hit = (re) => rs.filter(r => re.test(r));
  const row = (lbl, fails, okText) => ({ label: lbl, pass: fails.length === 0, reason: fails.length ? fails.join(' ') : okText });
  const ledger = hit(/ledger unavailable/i);
  const list = [
    row('Permission expiry', hit(/expired/i), `Valid until ${p.expiresAt ? new Date(p.expiresAt).toISOString() : '—'}.`),
    row('Allowed action', hit(/action/i), 'SOL transfer is permitted.'),
    row('Program', hit(/program/i), 'System Program only.'),
    row('Transaction limit', hit(/per-transaction|invalid amount/i), `${solN(amountSol)} is within the ${solN(p.maxSolPerTransaction)} per-transaction limit.`),
    row('Spending limit', hit(/budget/i), `Within the ${solN(p.maxSolTotal)} total, counting spend derived from chain.`),
    row('Recipient', hit(/destination/i), `${label(destination) || short(destination)} is on the allowlist.`),
  ];
  if (ledger.length) list.push(row('Chain ledger', ledger, ''));
  return list;
}
const checksList = (checks) => `<ol class="checks">${checks.map(c => `<li class="${c.pass ? 'ok' : 'bad'}"><span class="ic" aria-hidden="true">${c.pass ? '✓' : '✕'}</span><div><b>${esc(c.label)}</b><span>${esc(c.reason)}</span></div></li>`).join('')}</ol>`;

// ------------------------------------------------------------------ views
function renderOverview() {
  const p = H.policy || {}, st = H.state || {};
  const evals = H.audit.filter(e => e.kind === 'evaluate');
  const inflight = Object.entries(st.inflight || {});
  const pending = inflight.filter(([, v]) => v.txIndex != null);
  const tiles = [
    ['Policy', p.name ? `v${p.version}` : '—', p.expiresAt && Date.now() > new Date(p.expiresAt) ? 'expired' : 'active'],
    ['Evaluations', evals.length, 'recorded by the worker'],
    ['Approved', evals.filter(e => e.decision === 'allowed').length, 'policy checks passed'],
    ['Blocked', evals.filter(e => e.decision === 'rejected').length, 'with a reason each'],
    ['Executed spend', H.stateError ? '—' : sol(st.executedLamports), H.stateError ? 'worker /api/state unreadable from browsers (no CORS header)' : `of ${solN(p.maxSolTotal)} · derived from chain`],
  ];
  $('#stats').innerHTML = tiles.map(([k, v, s]) => `<div class="stat"><span class="k">${esc(k)}</span><b class="v">${esc(v)}</b><span class="s muted">${esc(s)}</span></div>`).join('');
  $('#ov-latest').innerHTML = evals.slice(-6).reverse().map(e => `<div class="row-btn" role="listitem"><span><span class="pill ${e.decision === 'allowed' ? 'ok' : 'bad'}">${e.decision === 'allowed' ? 'Approved' : 'Blocked'}</span></span><span>${who(e.destination)}</span><span class="num mono">${esc(solN(e.amountSol))}</span></div>`).join('') || '<p class="muted empty">No evaluations yet.</p>';
  const evs = securityEvents();
  $('#ov-events').innerHTML = evs.slice(0, 6).map(evRow).join('') || '<p class="muted empty">No security events.</p>';
  const expired = p.expiresAt && Date.now() > new Date(p.expiresAt).getTime();
  $('#exec-panel').innerHTML = `<div class="panel-h"><h2>Execution path</h2><span class="pill ${pending.length ? 'warn' : 'ok'}">${pending.length ? `${pending.length} awaiting gatekeeper` : 'Squads 2-of-2'}</span></div>
    <p class="muted">Live backend <a class="link mono" href="${WORKER}/api/health" target="_blank" rel="noopener">${esc(new URL(WORKER).host)}</a>.
    The hosted agent key creates the Squads proposal in multisig <a class="link mono" href="${explorer('address', MULTISIG)}" target="_blank" rel="noopener">${esc(short(MULTISIG))}</a> and casts approval 1 of 2. Funds move only after the owner-side gatekeeper verifies the on-chain transaction and casts approval 2 of 2. This page holds no keys and cannot propose.</p>
    ${expired ? `<p class="err">The live policy expired at ${esc(new Date(p.expiresAt).toISOString())}, so the worker blocks every proposal until the owner re-issues it.</p>` : ''}`;
}

function securityEvents() {
  const out = [];
  for (const e of H.audit) {
    if (e.kind === 'evaluate' && e.decision === 'rejected')
      for (const r of e.reasons || []) out.push({ ts: e.ts, type: /expired/i.test(r) ? 'Expired permission' : /per-transaction|invalid amount/i.test(r) ? 'Transaction limit' : /budget/i.test(r) ? 'Spending limit' : /destination/i.test(r) ? 'Unauthorized recipient' : /action/i.test(r) ? 'Disallowed action' : /program/i.test(r) ? 'Disallowed program' : /ledger/i.test(r) ? 'Ledger unavailable' : 'Policy violation', text: r });
    if (/failed/.test(e.kind)) out.push({ ts: e.ts, type: e.kind === 'propose-failed' ? 'Proposal failed' : 'Execution failed', text: String(e.error || '').slice(0, 200) });
    if (e.kind === 'reservation-cancelled') out.push({ ts: e.ts, type: 'Reservation released', text: `${e.authId}${e.txIndex != null ? ` (proposal #${e.txIndex})` : ''}: ${e.note || ''}`, quiet: true });
  }
  return out.reverse();
}
const evRow = (e) => `<div class="ev"><span class="pill ${e.quiet ? '' : 'bad'}">${esc(e.type)}</span><div><span>${esc(e.text)}</span><span class="muted small">${esc(ago(e.ts))}</span></div></div>`;

function renderPolicy() {
  const p = H.policy || {};
  const exp = p.expiresAt ? new Date(p.expiresAt) : null;
  const left = exp ? (exp - Date.now()) / 3600e3 : null;
  $('#agents-list').innerHTML = `<article class="agent panel">
    <div class="agent-h"><div><h2>Research Agent</h2><span class="mono small muted">${esc(p.name || '')}</span></div>
      <span class="pill ${left > 0 ? 'ok' : 'bad'}">${left > 0 ? 'Active' : 'Policy expired'}</span></div>
    <dl class="kv">
      <div><dt>Vault</dt><dd><a class="link mono" href="${explorer('address', VAULT)}" target="_blank" rel="noopener">${esc(short(VAULT))}</a></dd></div>
      <div><dt>Multisig</dt><dd><a class="link mono" href="${explorer('address', MULTISIG)}" target="_blank" rel="noopener">${esc(short(MULTISIG))}</a> · 2 of 2</dd></div>
      <div><dt>Per transaction</dt><dd>${esc(solN(p.maxSolPerTransaction))}</dd></div>
      <div><dt>Total limit</dt><dd>${esc(solN(p.maxSolTotal))}</dd></div>
      <div><dt>Actions</dt><dd>${(p.allowedActions || []).map(a => a === 'transfer' ? 'SOL transfers' : esc(a)).join(', ')}</dd></div>
      <div><dt>Expiry</dt><dd class="${left > 0 ? '' : 'bad-t'}">${exp ? esc(exp.toISOString()) : '—'}${left > 0 ? ` (${left < 1 ? Math.ceil(left * 60) + ' min' : left.toFixed(1) + ' h'} left)` : ' (expired)'}</dd></div>
      <div class="span"><dt>Approved recipients</dt><dd>${(p.allowedDestinations || []).map(a => `<span class="tag">Vendor A <span class="mono">${esc(short(a))}</span></span>`).join(' ')}</dd></div>
      <div class="span"><dt>Blocked</dt><dd>${(p.blockedDestinations || []).map(a => `<span class="tag"><span class="mono">${esc(short(a))}</span></span>`).join(' ') || '—'}</dd></div>
    </dl>
    <div class="meter" role="img" aria-label="Executed ${esc(sol(H.state?.executedLamports))} of ${esc(solN(p.maxSolTotal))}"><span style="width:${Math.min(100, ((H.state?.executedLamports || 0) / 1e9 / (p.maxSolTotal || 1)) * 100).toFixed(1)}%"></span></div>
    <p class="small muted">${H.stateError ? 'Executed spend unavailable in this browser.' : esc(sol(H.state?.executedLamports))} executed of ${esc(solN(p.maxSolTotal))}, derived from vault transactions carrying this policy's memo.</p>
    <p class="small muted">The live policy is set by the owner in the worker's configuration; this page shows it read-only.</p>
  </article>${renderProposals()}`;
}

function renderProposals() {
  if (H.stateError) return `<article class="panel"><div class="panel-h"><h2>Awaiting the gatekeeper</h2></div><p class="muted">Open proposals come from the worker's <code>/api/state</code>, which this browser could not read (the deployed worker sends no CORS header on that route). Proposals in the audit log are listed under History.</p></article>`;
  const inflight = Object.entries(H.state?.inflight || {}).filter(([, v]) => v.txIndex != null);
  const proposed = Object.fromEntries(H.audit.filter(e => e.kind === 'proposed').map(e => [e.authId, e]));
  if (!inflight.length) return `<article class="panel"><div class="panel-h"><h2>Awaiting the gatekeeper</h2></div><p class="muted">No open proposals. When the hosted agent proposes, it appears here with the command the owner runs.</p></article>`;
  return `<article class="panel"><div class="panel-h"><h2>Awaiting the gatekeeper</h2><span class="pill warn">${inflight.length}</span></div>
    ${inflight.map(([authId, v]) => { const pe = proposed[authId] || {}; const lam = Math.round(Number(pe.amountSol) * 1e9);
      const cmd = `node scripts/gatekeeper-execute.mjs ${v.txIndex} check${pe.destination ? ` --expect ${pe.destination} ${lam}` : ''}${pe.memo ? ` --expect-memo ${pe.memo}` : ''}`;
      return `<div class="ev"><span class="pill warn">#${esc(v.txIndex)}</span><div><span>${esc(solN(pe.amountSol ?? v.lamports / 1e9))} → ${pe.destination ? who(pe.destination) : '—'} · agent approved 1 of 2, funds not moved</span>
        <pre class="code">${esc(cmd)}\n${esc(cmd.replace(' check', ' approve'))}</pre></div></div>`; }).join('')}
    <p class="small muted">Run on the owner's machine, where GATEKEEPER_SECRET lives. <code>check</code> decodes the on-chain vault transaction and refuses anything it cannot classify; <code>approve</code> votes 2 of 2 and executes.</p></article>`;
}

function renderHistory() {
  const rows = H.audit.slice().reverse().filter(e => ['evaluate', 'proposed', 'execute-failed', 'propose-failed', 'reservation-cancelled'].includes(e.kind))
    .filter(e => H.filter === 'all' || (H.filter === 'ok' ? (e.decision === 'allowed' || e.kind === 'proposed') : (e.decision === 'rejected' || /failed/.test(e.kind))));
  const status = (e) => e.kind === 'proposed' ? '<span class="pill warn">Proposed 1 of 2</span>' : e.kind === 'evaluate' ? `<span class="pill ${e.decision === 'allowed' ? 'ok' : 'bad'}">${e.decision === 'allowed' ? 'Approved' : 'Blocked'}</span>` : /failed/.test(e.kind) ? '<span class="pill bad">Failed</span>' : '<span class="pill">Released</span>';
  $('#tx-table tbody').innerHTML = rows.map(e => `<tr>
    <td class="small">${esc(ago(e.ts))}</td><td>${e.kind === 'evaluate' ? 'Evaluation' : 'Hosted agent'}</td><td>${e.destination ? who(e.destination) : '—'}</td>
    <td class="num mono">${e.amountSol != null ? esc(solN(e.amountSol)) : '—'}</td><td>${status(e)}</td>
    <td class="reason">${esc((e.reasons || []).join(' ') || (e.kind === 'proposed' ? `Squads proposal #${e.txIndex} · ${e.memo || ''}` : e.error || e.note || 'All policy checks passed.'))}</td>
    <td>${e.sigs ? Object.values(e.sigs).slice(-1).map(s => `<a class="link mono" href="${explorer('tx', s)}" target="_blank" rel="noopener">${esc(short(s))}</a>`).join('') : '<span class="muted">—</span>'}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted empty">Nothing here yet.</td></tr>';
}

function renderEvents() {
  const evs = securityEvents();
  const counts = {}; for (const e of evs) counts[e.type] = (counts[e.type] || 0) + 1;
  $('#ev-summary').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="stat sm"><span class="k">${esc(k)}</span><b class="v">${n}</b></div>`).join('');
  $('#ev-list').innerHTML = evs.map(evRow).join('') || '<p class="muted empty">No security events.</p>';
}

// ------------------------------------------------------------------ propose (evaluate only)
function setupPropose() {
  const vendor = H.policy?.allowedDestinations?.[0] || '';
  const blocked = H.policy?.blockedDestinations?.[0] || '7GC8LGCn9vJ6jDQ1jQQ8ctyyRRcnSRWW2HvVDEsnKScM';
  $('#p-agent').innerHTML = '<option>Research Agent (live worker)</option>';
  $('#p-recipients').innerHTML = vendor ? `<option value="${esc(vendor)}">Vendor A</option>` : '';
  $$('[data-preset]').forEach(b => b.onclick = () => {
    const p = { ok: [vendor, 0.01], big: [vendor, 0.5], unknown: [blocked, 0.01] }[b.dataset.preset];
    $('#p-recipient').value = p[0]; $('#p-amount').value = p[1];
  });
  $('#propose-form').addEventListener('submit', async (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    const destination = $('#p-recipient').value.trim(), amountSol = Number($('#p-amount').value);
    const btn = $('#propose-form button[type=submit]'); btn.disabled = true;
    $('#decision').innerHTML = '<p class="muted empty">Asking the live worker…</p>';
    try {
      const d = await evaluate(destination, amountSol);
      $('#decision').innerHTML = `<div class="verdict ${d.allow ? 'ok' : 'bad'}"><span class="big">${d.allow ? 'APPROVED' : 'BLOCKED'}</span><span>${esc(d.allow ? 'All policy checks passed.' : d.reasons[0])}</span></div>
        <p class="small muted">${esc(solN(amountSol))} → <span class="mono">${esc(short(destination))}</span> · dry run on the live worker · policy v${esc(d.policyVersion ?? '—')}</p>
        ${checksList(checksFor(d, amountSol, destination))}
        <p class="small muted">${d.allow ? 'A dry run moves nothing. To pay, the hosted agent proposes (approval 1 of 2) and the owner-side gatekeeper verifies and approves 2 of 2.' : 'No proposal can be created for this payment: the worker applies the same checks before the agent may propose, and the gatekeeper refuses anything that does not match.'}</p>`;
      await load();
    } catch (err) { $('#decision').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    finally { btn.disabled = false; }
  }, true);
  $$('[data-filter]').forEach(b => b.onclick = () => { H.filter = b.dataset.filter; $$('[data-filter]').forEach(x => x.classList.toggle('on', x === b)); renderHistory(); });
}

async function load() {
  const [health, policy, audit] = await Promise.all([get('/api/health'), get('/api/policies'), get('/api/audit')]);
  // /api/state carries chain-derived spend and open proposals. The deployed
  // worker currently answers it without a CORS header, so a browser may be
  // refused; the console then says so instead of guessing the numbers.
  const state = await get('/api/state').catch(() => null);
  Object.assign(H, { health, policy, state, stateError: !state, audit: audit.entries || [] });
  $('#net-pill').textContent = 'devnet · live worker';
  renderOverview(); renderPolicy(); renderHistory(); renderEvents();
}

export async function bootHosted() {
  document.documentElement.dataset.backend = 'hosted';
  $('#signin').hidden = true; $('#app').hidden = false;
  $('#who-wallet').textContent = 'read-only';
  $('#btn-signout').hidden = true;
  $('[data-tab="agents"]').textContent = 'Policy';
  $('#h-agents').textContent = 'Policy and proposals';
  setupPropose();
  try { await load(); } catch (err) { $('#stats').innerHTML = `<p class="err">Live backend unreachable: ${esc(err.message)}</p>`; }
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 10000);
}
