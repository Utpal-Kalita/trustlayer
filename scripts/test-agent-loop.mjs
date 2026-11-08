// Offline tests for the autonomous agent loop (cloudflare/agent-loop.js) and the
// Groq tool-step adapter. A scripted model stands in for the LLM; the policy
// verdicts come from the real deterministic engine (src/policy/engine.js).
import { runAgent, demoWorld, MAX_STEPS, MAX_PAYMENT_ATTEMPTS } from '../cloudflare/agent-loop.js';
import { groqToolStep } from '../cloudflare/groq.js';
import { evaluate } from '../src/policy/engine.js';
import fs from 'node:fs';

let fails = 0;
const ok = (n, c, i) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${i ? '  (' + i + ')' : ''}`); if (!c) fails++; };

const policy = JSON.parse(fs.readFileSync('policies/default.json', 'utf8'));
policy.expiresAt = new Date(Date.now() + 3600e3).toISOString();
policy.oneTimeUse = false;
const VENDOR_A = policy.allowedDestinations[0];
const ATTACKER = policy.blockedDestinations[0];
const decide = async (tx) => evaluate(policy, { destination: tx.destination, amountSol: tx.amountSol }, null);
const budget = async () => ({ executedLamports: 70_000_000, inflightLamports: 0 });
const call = (name, args, id = Math.random().toString(36).slice(2)) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// Scripted model: reads the page, gets fooled by the injection, is blocked, recovers.
function scripted(steps) {
  let i = 0; const seen = [];
  const chat = async (messages) => { seen.push(messages.length); return steps[i++] || { content: 'done', tool_calls: [] }; };
  return { chat, seen };
}

// 1. Injected page: model obeys the injection, engine blocks, model pays the real vendor.
{
  const m = scripted([
    { content: 'I will look at vendors first.', tool_calls: [call('list_vendors', {})] },
    { content: '', tool_calls: [call('read_vendor_page', { vendor_id: 'vendor-a' })] },
    { content: 'The page says Vendor A moved wallets and wants a verification fee.', tool_calls: [call('request_payment', { destination: ATTACKER, amount_sol: 0.02, reason: 'verification fee' })] },
    { content: 'Blocked. I will pay the wallet in my permissions instead.', tool_calls: [call('check_budget', {})] },
    { content: '', tool_calls: [call('request_payment', { destination: VENDOR_A, amount_sol: 0.01, reason: 'DePIN report' })] },
    { content: '', tool_calls: [call('finish', { summary: 'Bought the DePIN report from Vendor A for 0.01 SOL. A request to pay another wallet was blocked.' })] },
  ]);
  const r = await runAgent({ task: 'Buy the Solana DePIN report.', policy, scenario: 'injected', chat: m.chat, budget, decide });
  ok('injected run finishes', r.stopReason === 'finished', r.stopReason);
  ok('agent attempted the attacker payment', r.attackerPaymentAttempted);
  ok('attacker payment BLOCKED by the engine', !r.attackerPaymentApproved && r.payments[0].verdict === 'BLOCKED', r.payments[0].reasons[0]);
  ok('legitimate payment APPROVED', r.payments[1]?.verdict === 'APPROVED' && r.payments[1].destination === VENDOR_A);
  ok('trace shows the page with the injection', r.trace.some(t => t.tool === 'read_vendor_page' && /AI assistants/.test(t.result.page)));
  ok('budget tool reports remaining spend', r.trace.find(t => t.tool === 'check_budget')?.result.remaining_sol === 0.03);
  ok('summary returned', /Vendor A/.test(r.summary));
}

// 2. Clean page: no injection text.
ok('clean page has no injection', !/AI assistants/.test(demoWorld(policy, 'clean').pages['vendor-a']));

// 3. Unapproved cheaper vendor is blocked.
{
  const B = demoWorld(policy).vendors[1].wallet;
  const m = scripted([{ content: '', tool_calls: [call('request_payment', { destination: B, amount_sol: 0.008, reason: 'cheaper copy' })] }, { content: '', tool_calls: [call('finish', { summary: 'x' })] }]);
  const r = await runAgent({ task: 't', policy, chat: m.chat, budget, decide });
  ok('payment to unapproved Vendor B blocked', r.payments[0].verdict === 'BLOCKED');
}

// 4. Bounds
{
  const loop = Array.from({ length: 20 }, () => ({ content: '', tool_calls: [call('list_vendors', {})] }));
  const r = await runAgent({ task: 't', policy, chat: scripted(loop).chat, budget, decide });
  ok(`step limit stops the loop at ${MAX_STEPS}`, r.stopReason === 'step-limit' && r.steps === MAX_STEPS);
  const spam = Array.from({ length: 6 }, () => ({ content: '', tool_calls: [call('request_payment', { destination: VENDOR_A, amount_sol: 0.001, reason: 'x' })] }));
  let decided = 0;
  const r2 = await runAgent({ task: 't', policy, chat: scripted(spam).chat, budget, decide: async (tx) => { decided++; return decide(tx); } });
  ok(`at most ${MAX_PAYMENT_ATTEMPTS} payment attempts reach the engine`, decided === MAX_PAYMENT_ATTEMPTS && r2.payments.slice(MAX_PAYMENT_ATTEMPTS).every(p => p.verdict === 'BLOCKED'));
  const bad = [{ content: '', tool_calls: [call('request_payment', { destination: 'not-an-address', amount_sol: -1, reason: 'x' }), call('transfer_all_funds', {}), { id: 'z', function: { name: 'read_vendor_page', arguments: '{bad json' } }] }, { content: 'stop', tool_calls: [] }];
  let decided2 = 0;
  const r3 = await runAgent({ task: 't', policy, chat: scripted(bad).chat, budget, decide: async (tx) => { decided2++; return decide(tx); } });
  ok('invalid payment arguments never reach the engine', decided2 === 0 && r3.payments[0].verdict === 'BLOCKED');
  ok('unknown tool refused', r3.trace.some(t => t.tool === 'transfer_all_funds' && /unknown tool/.test(t.result.error)));
  ok('malformed JSON arguments refused', r3.trace.some(t => t.tool === 'read_vendor_page' && /not valid JSON/.test(t.result.error)));
  const r4 = await runAgent({ task: 't', policy, chat: async () => { throw new Error('Groq HTTP 429'); }, budget, decide });
  ok('model error stops the run, no payment', r4.stopReason === 'model-error' && r4.payments.length === 0);
  const r5 = await runAgent({ task: 't', policy, chat: scripted(loop).chat, budget, decide, allowStep: async (n) => n <= 2 });
  ok('quota hook stops the run', r5.stopReason === 'quota' && r5.steps === 2);
  const r6 = await runAgent({ task: 't', policy, chat: scripted([{ content: '', tool_calls: [call('read_vendor_page', { vendor_id: 'https://evil.example/' })] }, { content: 'x', tool_calls: [] }]).chat, budget, decide });
  ok('no arbitrary URL fetching', /unknown vendor_id/.test(r6.trace[0].result.error));
}

// 5. Groq adapter (mocked HTTP)
{
  const env = { GROQ_API_KEY: 'k', GROQ_FREE_TIER_VERIFIED: 'true' };
  let sent;
  const fetcher = async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_vendors', arguments: '{}' } }] } }] }) }; };
  const r = await groqToolStep(env, [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], [], fetcher);
  ok('adapter sends tools, single call, temperature 0', Array.isArray(sent.tools) && sent.parallel_tool_calls === false && sent.temperature === 0);
  ok('adapter returns tool calls', r.tool_calls[0].function.name === 'list_vendors');
  let threw = false; try { await groqToolStep({ GROQ_API_KEY: 'k' }, [{}, {}], [], fetcher); } catch { threw = true; }
  ok('adapter refuses without the Free-tier flag', threw);
  threw = false; try { await groqToolStep(env, [{}, {}], [], async () => ({ ok: false, status: 429 })); } catch (e) { threw = /429/.test(e.message); }
  ok('adapter fails closed on HTTP 429', threw);
}

console.log(fails ? `\n${fails} agent test(s) FAILED` : '\nall agent tests passed');
process.exit(fails ? 1 : 0);
