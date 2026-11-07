// TrustLayer policy-engine unit tests. Run: npm test
// No chain, no keys, no secrets - deterministic and offline.
import { evaluate, AuditLog } from '../src/policy/engine.js';
import fs from 'node:fs';

const FILE = 'data/test-audit.log';
fs.rmSync(FILE, { force: true });
const audit = new AuditLog(FILE);
const policy = JSON.parse(fs.readFileSync('policies/default.json', 'utf8'));
policy.expiresAt = new Date(Date.now() + 7200e3).toISOString(); // fresh window for tests

let failures = 0;
const ok = (name, cond) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) failures++; };
const V = policy.allowedDestinations[0];
const A = policy.blockedDestinations[0];

// allow + one-time replay protection bound to canonical tx + policy version
let d1 = evaluate(policy, { destination: V, amountSol: 0.04 }, audit);
ok('first 0.04 allowed, authId derived', d1.allow && d1.authId?.length === 16);
audit.record({ id: 't1', nonce: d1.authId, destination: V, amountSol: 0.04, decision: 'allowed', executed: true, kind: 'execute' });
ok('identical repeat rejected as replay', !evaluate(policy, { destination: V, amountSol: 0.04 }, audit).allow);
ok('caller-supplied version field has no effect on binding', evaluate(policy, { destination: V, amountSol: 0.04, version: 999 }, audit).authId === d1.authId);

// different content = different authorization; integer-lamports at-cap boundary
let d2 = evaluate(policy, { destination: V, amountSol: 0.05 }, audit);
ok('different amount allowed at exact cap (0.04+0.05=0.09<=0.1)', d2.allow);
audit.record({ id: 't2', nonce: d2.authId, destination: V, amountSol: 0.05, decision: 'allowed', executed: true, kind: 'execute' });
ok('0.02 over remaining 0.01 budget rejected', !evaluate(policy, { destination: V, amountSol: 0.02 }, audit).allow);

// destination rules
ok('blocked destination rejected', !evaluate(policy, { destination: A, amountSol: 0.01 }, audit).allow);
ok('non-allowlisted destination rejected', !evaluate(policy, { destination: 'So1anaFakeDest1111111111111111111111111111', amountSol: 0.01 }, audit).allow);

// reservation lifecycle: inflight blocks, release frees for retry
fs.rmSync(FILE, { force: true });
let d3 = evaluate(policy, { destination: V, amountSol: 0.04 }, audit);
audit.record({ id: 't3', nonce: d3.authId, amountSol: 0.04, reserved: true, decision: 'allowed', kind: 'propose' });
let d4 = evaluate(policy, { destination: V, amountSol: 0.04 }, audit);
ok('in-flight duplicate rejected', !d4.allow && d4.reasons.some(r => r.includes('in flight')));
audit.record({ id: 't3', nonce: d3.authId, released: true, kind: 'execute' });
ok('retry after failure allowed', evaluate(policy, { destination: V, amountSol: 0.04 }, audit).allow);

// expiry enforced
const expired = { ...policy, expiresAt: new Date(Date.now() - 1000).toISOString() };
ok('expired policy rejects', !evaluate(expired, { destination: V, amountSol: 0.01 }, audit).allow);

fs.rmSync(FILE, { force: true });
console.log(failures ? `${failures} FAILURES` : 'all tests passed');
process.exit(failures ? 1 : 0);
