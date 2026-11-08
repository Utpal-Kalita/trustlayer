// TrustLayer console. Vanilla JS against the PRD section 11 API.
// Every value from the API is escaped before it reaches the DOM.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const API = (window.TRUSTLAYER_API || '').replace(/\/$/, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SOL = 1e9;
const sol = (l) => `${+(Number(l || 0) / SOL).toFixed(9)} SOL`;
const short = (a) => a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '—');
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? `${Math.max(1, s | 0)}s ago` : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : new Date(iso).toLocaleDateString(); };
const until = (iso) => { const s = (new Date(iso) - Date.now()) / 1000; if (s <= 0) return 'expired'; return s < 3600 ? `${Math.ceil(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`; };
const explorer = (sig) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } } };

const S = { token: store.get('tl_token'), wallet: store.get('tl_wallet'), health: null, agents: [], txs: [], events: [], filter: 'all' };

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/auth/verify') { signOut(); throw new Error(d.error || 'signed out'); }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// ------------------------------------------------------------- sign-in
function bs58encode(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
async function phantomSignIn() {
  const p = window.phantom?.solana || window.solana;
  if (!p?.isPhantom) { window.open('https://phantom.com/download', '_blank', 'noopener'); throw new Error('Phantom is not installed in this browser. Install it, switch it to devnet, then try again.'); }
  const { publicKey } = await p.connect();
  const wallet = publicKey.toString();
  const { message } = await api('POST', '/api/auth/challenge', { wallet });
  const { signature } = await p.signMessage(new TextEncoder().encode(message), 'utf8');
  const out = await api('POST', '/api/auth/verify', { wallet, signature: bs58encode(signature) });
  return { token: out.token, wallet };
}
function signedIn({ token, wallet }) { S.token = token; S.wallet = wallet; store.set('tl_token', token); store.set('tl_wallet', wallet); boot(); }
function signOut() { S.token = null; store.set('tl_token', null); store.set('tl_wallet', null); $('#app').hidden = true; $('#signin').hidden = false; }

$('#btn-phantom').onclick = async (e) => {
  const b = e.currentTarget; b.disabled = true; $('#signin-err').textContent = '';
  try { signedIn(await phantomSignIn()); } catch (err) { $('#signin-err').textContent = err.message; } finally { b.disabled = false; }
};
$('#btn-demo').onclick = async () => {
  try { const out = await api('POST', '/api/auth/demo'); signedIn({ token: out.token, wallet: out.user.wallet_address }); } catch (err) { $('#signin-err').textContent = err.message; }
};
$('#btn-signout').onclick = signOut;

// ------------------------------------------------------------- tabs
function showTab() {
  const id = (location.hash || '#overview').slice(1);
  const name = ['overview', 'agents', 'propose', 'history', 'security'].includes(id) ? id : 'overview';
  $$('.view').forEach(v => v.hidden = v.id !== `view-${name}`);
  $$('[data-tab]').forEach(a => a.setAttribute('aria-current', a.dataset.tab === name ? 'page' : 'false'));
}
addEventListener('hashchange', showTab);

// ------------------------------------------------------------- render helpers
const STATUS = {
  executed: ['ok', 'Executed'], approved: ['ok', 'Approved'], reserved: ['warn', 'Executing'],
  rejected: ['bad', 'Blocked'], failed: ['bad', 'Not executed'],
};
const statusPill = (s) => { const [k, l] = STATUS[s] || ['', s]; return `<span class="pill ${k}">${esc(l)}</span>`; };
const EVENT_LABELS = {
  transaction_limit_violation: 'Transaction limit', spending_limit_violation: 'Spending limit', unauthorized_recipient: 'Unauthorized recipient',
  expired_permission: 'Expired permission', disallowed_action: 'Disallowed action', failed_simulation: 'Failed simulation',
  inactive_agent: 'Inactive agent', unsupported_transaction: 'Unsupported transaction', sender_mismatch: 'Wrong sender',
  replay_attempt: 'Replay attempt', execution_failed: 'Execution failed', agent_deactivated: 'Agent deactivated',
  agent_reactivated: 'Agent reactivated', agent_key_rotated: 'Key rotated',
};
function recipientName(t) {
  const a = S.agents.find(x => x.id === t.agent_id);
  const hit = a?.policy?.approved_recipients?.find(r => r.address === t.recipient);
  return hit ? `${esc(hit.label)} <span class="mono muted small">${esc(short(t.recipient))}</span>` : `<span class="mono">${esc(short(t.recipient))}</span>`;
}
function checksList(checks = []) {
  return `<ol class="checks">${checks.map(c => `<li class="${c.pass === true ? 'ok' : c.pass === false ? 'bad' : 'skip'}"><span class="ic" aria-hidden="true">${c.pass === true ? '✓' : c.pass === false ? '✕' : '–'}</span><div><b>${esc(c.label)}</b><span>${esc(c.reason)}</span></div></li>`).join('')}</ol>`;
}

// ------------------------------------------------------------- overview
async function loadOverview() {
  const o = await api('GET', '/api/overview');
  const tiles = [
    ['Registered agents', o.agents, `${o.activeAgents} active`],
    ['Transactions proposed', o.proposed, 'every attempt recorded'],
    ['Approved', o.approved, `${o.executed} executed on chain`],
    ['Blocked', o.rejected, 'with a reason each'],
    ['Authorized spending', sol(o.authorizedLamports), 'executed through Squads'],
  ];
  $('#stats').innerHTML = tiles.map(([k, v, s]) => `<div class="stat"><span class="k">${esc(k)}</span><b class="v">${esc(v)}</b><span class="s muted">${esc(s)}</span></div>`).join('');
  $('#ov-latest').innerHTML = S.txs.slice(0, 6).map(t => `<button class="row-btn" type="button" data-tx="${esc(t.id)}"><span>${statusPill(t.status)}</span><span>${esc(t.agent_name || '')} → ${recipientName(t)}</span><span class="num mono">${esc(sol(t.amount_lamports))}</span></button>`).join('') || `<p class="muted empty">No proposals yet. <a class="link" href="#propose">Propose one</a>.</p>`;
  $('#ov-events').innerHTML = S.events.slice(0, 6).map(evRow).join('') || '<p class="muted empty">No security events.</p>';
  const ex = S.health?.execution || {};
  $('#exec-panel').innerHTML = `<div class="panel-h"><h2>Execution path</h2><span class="pill ${ex.enabled ? 'ok' : 'warn'}">${ex.enabled ? 'Squads 2-of-2 ready' : 'Evaluate-only'}</span></div>
    <p class="muted">${ex.enabled
      ? `Approved proposals execute from vault <a class="link mono" href="https://explorer.solana.com/address/${esc(ex.vault)}?cluster=devnet" target="_blank" rel="noopener">${esc(short(ex.vault))}</a> in multisig <a class="link mono" href="https://explorer.solana.com/address/${esc(ex.multisig)}?cluster=devnet" target="_blank" rel="noopener">${esc(short(ex.multisig))}</a>. The agent casts vote 1, TrustLayer's gatekeeper casts vote 2 only after every check passes.`
      : `This server can evaluate proposals but will not sign: ${esc(ex.reason || 'execution disabled')}.`}
      Simulation: <b>${esc(S.health?.simulation)}</b> on ${esc(S.health?.cluster)}.</p>`;
}
const evRow = (e) => `<div class="ev"><span class="pill ${/deactivated|rotated|reactivated/.test(e.event_type) ? '' : 'bad'}">${esc(EVENT_LABELS[e.event_type] || e.event_type)}</span><div><span>${esc(e.description)}</span><span class="muted small">${esc(e.agent_name || '')} · ${esc(ago(e.created_at))}</span></div>${e.transaction_id ? `<button class="btn ghost small" type="button" data-tx="${esc(e.transaction_id)}">View</button>` : ''}</div>`;

// ------------------------------------------------------------- agents
function agentCard(a) {
  const p = a.policy;
  const pct = p ? Math.min(100, (a.spent_lamports / p.spending_limit_lamports) * 100) : 0;
  return `<article class="agent panel">
    <div class="agent-h"><div><h2>${esc(a.name)}</h2><span class="mono small muted">${esc(a.id)}</span></div>
      <span class="pill ${a.status === 'active' ? 'ok' : 'bad'}">${a.status === 'active' ? 'Active' : 'Inactive'}</span></div>
    <dl class="kv">
      <div><dt>Vault</dt><dd><a class="link mono" href="https://explorer.solana.com/address/${esc(a.wallet_address)}?cluster=devnet" target="_blank" rel="noopener">${esc(short(a.wallet_address))}</a></dd></div>
      <div><dt>Registered</dt><dd>${esc(new Date(a.created_at).toLocaleString())}</dd></div>
      ${p ? `<div><dt>Per transaction</dt><dd>${esc(sol(p.max_transaction_lamports))}</dd></div>
      <div><dt>Total limit</dt><dd>${esc(sol(p.spending_limit_lamports))}</dd></div>
      <div><dt>Actions</dt><dd>${p.allowed_actions.map(x => x === 'sol_transfer' ? 'SOL transfers' : 'SPL transfers').join(', ')}</dd></div>
      <div><dt>Expiry</dt><dd class="${p.expired ? 'bad-t' : ''}">${esc(until(p.expires_at))}</dd></div>
      <div class="span"><dt>Approved recipients</dt><dd>${p.approved_recipients.map(r => `<span class="tag">${esc(r.label)} <span class="mono">${esc(short(r.address))}</span></span>`).join(' ') || '<span class="muted">none</span>'}</dd></div>` : '<div class="span"><dt>Policy</dt><dd class="bad-t">No policy: every proposal is blocked.</dd></div>'}
    </dl>
    ${p ? `<div class="meter" role="img" aria-label="Spent ${esc(sol(a.spent_lamports))} of ${esc(sol(p.spending_limit_lamports))}"><span style="width:${pct.toFixed(1)}%"></span></div><p class="small muted">${esc(sol(a.spent_lamports))} of ${esc(sol(p.spending_limit_lamports))} spent · policy v${esc(p.version)}</p>` : ''}
    <div class="actions left">
      <button class="btn small" type="button" data-act="policy" data-id="${esc(a.id)}">${p ? 'Edit permissions' : 'Create policy'}</button>
      <button class="btn small" type="button" data-act="toggle" data-id="${esc(a.id)}">${a.status === 'active' ? 'Deactivate' : 'Activate'}</button>
      <button class="btn small ghost" type="button" data-act="rotate" data-id="${esc(a.id)}">Revoke key and issue new</button>
      <a class="btn small ghost" href="#propose" data-act="propose" data-id="${esc(a.id)}">Propose as this agent</a>
    </div></article>`;
}
function renderAgents() {
  $('#agents-list').innerHTML = S.agents.map(agentCard).join('') || `<div class="panel"><p class="muted empty">No agents yet. Register one to give it a vault and a policy.</p></div>`;
  const sel = $('#p-agent'), cur = sel.value;
  sel.innerHTML = S.agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}${a.status !== 'active' ? ' (inactive)' : ''}</option>`).join('');
  if (cur && S.agents.some(a => a.id === cur)) sel.value = cur;
  syncRecipients();
}
$('#agents-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = S.agents.find(x => x.id === b.dataset.id);
  if (b.dataset.act === 'toggle') { await api('PATCH', `/api/agents/${a.id}`, { status: a.status === 'active' ? 'inactive' : 'active' }); refresh(); }
  if (b.dataset.act === 'rotate') { if (!confirm(`Revoke ${a.name}'s current key? The agent stops working until it gets the new one.`)) return; const out = await api('POST', `/api/agents/${a.id}/rotate-key`); showKey(out.apiKey, a.id); refresh(); }
  if (b.dataset.act === 'policy') openPolicy(a);
  if (b.dataset.act === 'propose') { $('#p-agent').value = a.id; syncRecipients(); }
});

// Policy fieldset shared by register + edit dialogs
function policyFields(root, p = {}) {
  const recips = p.approved_recipients?.length ? p.approved_recipients : [{ label: 'Vendor A', address: '' }];
  root.innerHTML = `<legend>Permissions</legend>
    <div class="field two"><div><label>Max per transaction (SOL)<input name="max" type="number" min="0" step="0.001" value="${esc(p.max_transaction_lamports != null ? p.max_transaction_lamports / SOL : 0.05)}" required></label></div>
    <div><label>Total spending limit (SOL)<input name="total" type="number" min="0" step="0.001" value="${esc(p.spending_limit_lamports != null ? p.spending_limit_lamports / SOL : 0.1)}" required></label></div></div>
    <div class="field"><span class="lbl">Approved recipients</span><div class="recips">${recips.map(recipRow).join('')}</div><button class="btn ghost small" type="button" data-add-recip>Add a recipient</button></div>
    <div class="field"><span class="lbl">Allowed actions</span>
      <label class="check"><input type="checkbox" name="act" value="sol_transfer" ${!p.allowed_actions || p.allowed_actions.includes('sol_transfer') ? 'checked' : ''}> SOL transfers</label>
      <label class="check"><input type="checkbox" name="act" value="spl_transfer" ${p.allowed_actions?.includes('spl_transfer') ? 'checked' : ''}> SPL token transfers <span class="muted small">(decoded, not yet executable)</span></label></div>
    <div class="field"><label>Permission expires in (hours)<input name="hours" type="number" min="0.05" step="0.25" value="${esc(p.expires_at ? Math.max(0.25, +((new Date(p.expires_at) - Date.now()) / 3600e3).toFixed(2)) : 2)}" required></label></div>`;
}
const recipRow = (r) => `<div class="recip"><input name="rlabel" aria-label="Recipient name" value="${esc(r.label)}" maxlength="60"><input name="raddr" class="mono" aria-label="Recipient address" value="${esc(r.address)}" spellcheck="false" placeholder="Solana address"><button class="btn ghost small" type="button" data-del-recip aria-label="Remove recipient">Remove</button></div>`;
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-add-recip]')) e.target.previousElementSibling.insertAdjacentHTML('beforeend', recipRow({ label: '', address: '' }));
  if (e.target.matches('[data-del-recip]')) e.target.closest('.recip').remove();
});
function readPolicy(root) {
  const f = (n) => root.querySelector(`[name="${n}"]`).value;
  return {
    maxTransactionSol: Number(f('max')), spendingLimitSol: Number(f('total')), expiresInHours: Number(f('hours')),
    allowedActions: $$('[name="act"]:checked', root).map(x => x.value),
    approvedRecipients: $$('.recip', root).map(r => ({ label: $('[name="rlabel"]', r).value.trim(), address: $('[name="raddr"]', r).value.trim() })).filter(r => r.address),
  };
}

$('#btn-new-agent').onclick = () => {
  const d = $('#dlg-agent'); policyFields($('#a-policy'));
  const v = S.health?.execution?.vault;
  $('#a-wallet').value = v || '';
  $('#a-wallet-note').textContent = v ? 'Defaults to this server\'s Squads vault, so approved proposals can execute.' : 'This server has no Squads vault; the agent can be evaluated but not executed here.';
  $('.err', d).textContent = ''; d.showModal();
};
$('#agent-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const d = $('#dlg-agent');
  try {
    const out = await api('POST', '/api/agents', { name: $('#a-name').value, walletAddress: $('#a-wallet').value.trim(), policy: readPolicy($('#a-policy')) });
    d.close(); showKey(out.apiKey, out.agent.id); refresh();
  } catch (err) { $('.err', d).textContent = err.message; }
});

let editing = null;
function openPolicy(a) {
  editing = a; const d = $('#dlg-policy');
  policyFields($('#e-policy'), a.policy || {});
  $('#policy-meta').textContent = a.policy ? `${a.name} · policy v${a.policy.version}. Saving creates v${a.policy.version + 1}; the next proposal is judged by it.` : `${a.name} has no policy yet.`;
  $('.err', d).textContent = ''; d.showModal();
}
$('#policy-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const d = $('#dlg-policy');
  try {
    const body = readPolicy($('#e-policy'));
    if (editing.policy) await api('PATCH', `/api/policies/${editing.policy.id}`, body);
    else await api('POST', '/api/policies', { agentId: editing.id, ...body });
    d.close(); refresh();
  } catch (err) { $('.err', d).textContent = err.message; }
});

function showKey(key, agentId) {
  $('#key-value').textContent = key;
  $('#key-curl').textContent = `curl -X POST ${location.origin}/api/transactions/evaluate \\\n  -H 'content-type: application/json' \\\n  -H 'x-agent-key: ${key}' \\\n  -d '{"recipient":"<address>","amountSol":0.01}'`;
  $('#btn-copy').onclick = () => navigator.clipboard?.writeText(key).then(() => { $('#btn-copy').textContent = 'Copied'; });
  $('#btn-copy').textContent = 'Copy';
  $('#dlg-key').showModal();
}

// ------------------------------------------------------------- propose
function syncRecipients() {
  const a = S.agents.find(x => x.id === $('#p-agent').value) || S.agents[0];
  $('#p-recipients').innerHTML = (a?.policy?.approved_recipients || []).map(r => `<option value="${esc(r.address)}">${esc(r.label)}</option>`).join('');
}
$('#p-agent').addEventListener('change', syncRecipients);
const UNKNOWN_WALLET = '7GC8LGCn9vJ6jDQ1jQQ8ctyyRRcnSRWW2HvVDEsnKScM';
$$('[data-preset]').forEach(b => b.onclick = () => {
  const a = S.agents.find(x => x.id === $('#p-agent').value);
  const first = a?.policy?.approved_recipients?.[0]?.address || '';
  const p = { ok: [first, 0.01], big: [first, 0.5], unknown: [UNKNOWN_WALLET, 0.01] }[b.dataset.preset];
  $('#p-recipient').value = p[0]; $('#p-amount').value = p[1]; $('#p-action').value = 'sol_transfer';
});
$('#propose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || 'evaluate';
  const btns = $$('#propose-form button[type=submit]'); btns.forEach(b => b.disabled = true);
  $('#decision').innerHTML = `<p class="muted empty">${mode === 'execute' ? 'Inspecting, simulating, checking policy, then running the Squads vote and execution on devnet. This takes a few seconds.' : 'Inspecting, simulating and checking policy…'}</p>`;
  try {
    const body = { agentId: $('#p-agent').value, recipient: $('#p-recipient').value.trim(), amountSol: Number($('#p-amount').value), action: $('#p-action').value };
    if ($('#p-nonce').value.trim()) body.nonce = $('#p-nonce').value.trim();
    renderDecision(await api('POST', `/api/transactions/${mode}`, body), mode);
    refresh();
  } catch (err) { $('#decision').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  finally { btns.forEach(b => b.disabled = false); syncExec(); }
});
function renderDecision(d, mode) {
  const t = d.transaction || {};
  const ok = d.decision === 'APPROVED';
  $('#decision').innerHTML = `<div class="verdict ${ok ? 'ok' : 'bad'}"><span class="big">${esc(d.decision)}</span><span>${esc(d.explanation || d.reasons?.[0] || '')}</span></div>
    <p class="small muted">${esc(sol(t.amount_lamports))} → <span class="mono">${esc(short(t.recipient))}</span> · ${mode === 'execute' ? 'execute' : 'evaluate only'} · policy v${esc(t.policy_version ?? '—')}</p>
    ${checksList(d.checks)}
    ${d.signature ? `<p class="sig">Executed by the Squads vault: <a class="link mono" href="${explorer(d.signature)}" target="_blank" rel="noopener">${esc(short(d.signature))}</a></p>` : ''}
    ${!ok ? '<p class="small muted">No signature was produced. The gatekeeper never votes on a blocked proposal, and the agent holds only one of the two required votes.</p>' : ''}
    ${t.status === 'failed' ? `<p class="err">${esc(t.rejection_reason)}</p>` : ''}`;
}
function syncExec() {
  const ex = S.health?.execution || {};
  const a = S.agents.find(x => x.id === $('#p-agent').value);
  const can = ex.enabled && a && a.wallet_address === ex.vault;
  $('#btn-exec').disabled = !can;
  $('#exec-note').textContent = can ? 'Execute runs every check again on the server, then the Squads vote and execution on devnet.'
    : ex.enabled ? 'This agent\'s vault is not managed by this server, so it can be evaluated but not executed here.'
    : `Execution is off on this server: ${ex.reason || 'no signing setup'}. Evaluation works.`;
}
$('#p-agent').addEventListener('change', syncExec);

// ------------------------------------------------------------- history
function renderHistory() {
  const rows = S.txs.filter(t => S.filter === 'all' || (S.filter === 'ok' ? ['approved', 'executed', 'reserved'].includes(t.status) : ['rejected', 'failed'].includes(t.status)));
  $('#tx-table tbody').innerHTML = rows.map(t => `<tr data-tx="${esc(t.id)}" tabindex="0">
    <td class="small">${esc(ago(t.created_at))}</td><td>${esc(t.agent_name || '')}</td><td>${recipientName(t)}</td>
    <td class="num mono">${esc(sol(t.amount_lamports))}</td><td>${statusPill(t.status)}</td>
    <td class="reason">${esc(t.rejection_reason || t.explanation || '')}</td>
    <td>${t.transaction_signature ? `<a class="link mono" href="${explorer(t.transaction_signature)}" target="_blank" rel="noopener">${esc(short(t.transaction_signature))}</a>` : '<span class="muted">—</span>'}</td></tr>`).join('')
    || `<tr><td colspan="7" class="muted empty">Nothing here yet.</td></tr>`;
}
$$('[data-filter]').forEach(b => b.onclick = () => { S.filter = b.dataset.filter; $$('[data-filter]').forEach(x => x.classList.toggle('on', x === b)); renderHistory(); });
document.addEventListener('click', (e) => { const r = e.target.closest('[data-tx]'); if (r && !e.target.closest('a')) openTx(r.dataset.tx); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-tx]')) openTx(e.target.dataset.tx); });
function openTx(id) {
  const t = S.txs.find(x => x.id === id); if (!t) return;
  const sim = t.simulation;
  $('#tx-detail').innerHTML = `<div class="verdict ${['approved', 'executed'].includes(t.status) ? 'ok' : 'bad'}"><span class="big">${STATUS[t.status]?.[1] || esc(t.status)}</span><span>${esc(t.rejection_reason || t.explanation || '')}</span></div>
    <dl class="kv">
      <div><dt>Agent</dt><dd>${esc(t.agent_name)}</dd></div><div><dt>Time</dt><dd>${esc(new Date(t.created_at).toLocaleString())}</dd></div>
      <div><dt>Sender</dt><dd class="mono">${esc(short(t.sender))}</dd></div><div><dt>Recipient${t.recipients?.length > 1 ? 's' : ''}</dt><dd class="mono">${(t.recipients || [t.recipient]).map(r => esc(short(r))).join(', ')}</dd></div>
      <div><dt>Amount</dt><dd>${esc(sol(t.amount_lamports))}</dd></div><div><dt>Type</dt><dd>${esc(t.transaction_type)}</dd></div>
      <div><dt>Programs</dt><dd class="mono">${(t.programs || []).map(p => esc(short(p))).join(', ') || '—'}</dd></div><div><dt>Policy version</dt><dd>${esc(t.policy_version ?? '—')}</dd></div>
      <div><dt>Mode</dt><dd>${esc(t.mode)} · ${esc(t.source)}</dd></div><div><dt>Signature</dt><dd>${t.transaction_signature ? `<a class="link mono" href="${explorer(t.transaction_signature)}" target="_blank" rel="noopener">${esc(short(t.transaction_signature))}</a>` : '—'}</dd></div>
    </dl>
    <h3>Checks</h3>${checksList(t.checks)}
    ${t.instructions?.length ? `<h3>Decoded instructions</h3><ol class="ixs">${t.instructions.map(i => `<li class="mono small">${esc(i.action)} ${i.lamports != null ? esc(sol(i.lamports)) : ''} ${i.from ? esc(short(i.from)) + ' → ' : ''}${esc(short(i.to || ''))} <span class="muted">${esc(short(i.programId || ''))}</span></li>`).join('')}</ol>` : ''}
    ${sim?.logs?.length ? `<h3>Simulation logs</h3><pre class="code">${esc(sim.logs.join('\n'))}</pre>` : ''}
    ${t.execution?.steps ? `<h3>Squads execution</h3><ol class="ixs">${t.execution.steps.map(s => `<li class="small">${esc(s.step)} ${s.sig ? `<a class="link mono" href="${explorer(s.sig)}" target="_blank" rel="noopener">${esc(short(s.sig))}</a>` : ''}</li>`).join('')}</ol>` : ''}`;
  $('#dlg-tx').showModal();
}

// ------------------------------------------------------------- security
function renderEvents() {
  const counts = {};
  for (const e of S.events) counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  $('#ev-summary').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="stat sm"><span class="k">${esc(EVENT_LABELS[k] || k)}</span><b class="v">${n}</b></div>`).join('');
  $('#ev-list').innerHTML = S.events.map(evRow).join('') || '<p class="muted empty">No security events. Blocked proposals and owner actions appear here.</p>';
}

// ------------------------------------------------------------- data loop
async function refresh() {
  try {
    const [h, a, t, e] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/agents'), api('GET', '/api/transactions'), api('GET', '/api/security-events')]);
    S.health = h; S.agents = a.agents; S.txs = t.transactions; S.events = e.events;
    $('#net-pill').textContent = `${h.cluster.replace('api.', '').replace('.solana.com', '')} · simulation ${h.simulation}`;
    renderAgents(); renderHistory(); renderEvents(); syncExec();
    await loadOverview();
  } catch (err) { console.warn(err); }
}
async function boot() {
  $('#signin').hidden = true; $('#app').hidden = false;
  $('#who-wallet').textContent = short(S.wallet);
  showTab(); await refresh();
}
(async () => {
  try { S.health = await api('GET', '/api/health'); $('#btn-demo').hidden = !S.health.demoLogin; } catch { /* offline */ }
  if (S.token) { try { await api('GET', '/api/me'); return boot(); } catch { /* expired */ } }
  signOut();
})();
setInterval(() => { if (S.token && !document.hidden && !$('dialog[open]')) refresh(); }, 6000);
