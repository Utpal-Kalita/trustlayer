# Hosted signing — durable spend-state design (prototype)

Status: **prototype, local tests only. No hosted secrets, no hosted signing enabled.**
This document records how TrustLayer can keep spend/replay controls durable on
hosts with ephemeral disks (Render free, serverless workers), and the limits
that remain.

## Problem

The policy engine's budget and replay state (spend counters, reservations,
consumed authorizations) currently lives in a local append-only log
(`data/audit.log`). On a host whose disk resets on redeploy/restart, that state
silently resets — an attacker or a retried request could spend past the policy
budget. The hosted API therefore runs read-only today (propose/policy-update
return 503).

## Design: the chain is the ledger

Every proposal the engine creates carries a SPL Memo instruction:

```
trustlayer:<policyId>:v<policyVersion>:<authId>
```

- **Executed spend** = sum of outgoing vault transfers in confirmed
  transactions carrying this policy's memo (`deriveExecutedSpendLamports`).
  It survives any host restart because it is derived from the chain.
- **Pending reservations** = sum of unexecuted Squads proposals whose vault
  transaction carries the memo (`derivePendingReservationsLamports`).
  Proposals persist on-chain, so a crash after "propose" never loses the
  reservation: on restart, bootstrap re-derives it.
- **Atomic check+reserve** within one proposer is serialized in-process
  (`SpendGate`). The on-chain reservation (the created proposal) is the
  durable record; the in-process gate only prevents concurrent overspend
  between "check" and "propose".

### Answered threats (with tests, `scripts/test-onchain-ledger.mjs`)

1. **Replay via repeated identical NEW proposals** — Squads prevents
   re-executing the *same* proposal, not clones. Mitigation: budget check
   counts executed + pending reservations *before* creating any proposal, and
   each authorization id (`authId`, content-bound: action/program/destination/
   lamports/policy version) may hold at most one reservation. A retried
   request with the same content maps to the same authId and is rejected as
   in-flight. (tests: race test, replay rejection)
2. **Concurrent in-flight overspend** — `SpendGate` serializes check+reserve;
   N parallel requests cannot exceed the budget. (test: race test)
3. **Crash/confirmation ambiguity** — a crash after propose leaves the
   proposal on-chain; bootstrap counts it as reserved. A crash after execute
   leaves the executed transfer on-chain; bootstrap counts it as spent.
   In-memory state is never authoritative. (test: crash-recovery)
4. **Fail-closed bootstrap/restart** — if RPC reads fail, bootstrap throws
   `LedgerUnavailable` and no execution is allowed until it succeeds.
   (tests: RPC failure, pre-bootstrap)
5. **Immutable policy→authority mapping** — memos bind spend to `policyId`,
   not the mutable version. A version bump (owner re-issue) does not reset
   spend; callers cannot inject `policyId`/`version` — they come only from the
   server-side policy file. Rotating `policyId` (a true budget reset) requires
   owner re-issue via the key-guarded policy endpoint. (tests: version-bump,
   no caller injection)
6. **Agent/gatekeeper separation** — unchanged: the agent key only creates
   proposals (1 of 2); execution still requires the gatekeeper signature in
   the 2-of-2 Squads multisig. Hosting the agent key does not let the host
   move funds alone.
7. **No stale-cache overspend** — no spend cache: every bootstrap re-derives
   from the chain; between bootstraps the gate only ever *adds* its own
   reservations. An RPC outage blocks new executions rather than serving stale
   "budget available" answers.

### Remaining limits (honest)

- **Multi-host proposers** would need an on-chain lock (e.g., a single
  proposer authority rotating via the multisig). Out of scope: exactly one
  hosted proposer instance.
- **Public devnet RPC rate limits** — reads can fail under load; the design
  fails closed (rejects new spends) rather than approximating. Mitigation:
  dedicated RPC with the provider's free tier, still no paid plan.
- **History paging** — derivation pages `getSignaturesForAddress`; a very long
  vault history needs cursor pagination (implemented `pageLimit`, production
  should page until the policy's `issuedAt`).
- **Address lookup tables** are not resolved in vault-transaction decoding;
  our own proposals never use ALTs. A foreign proposal with ALTs and a forged
  memo is still gated by the multisig threshold, but its reservation amount
  may be undercounted — production should resolve ALTs.

## Where this can run (assessed separately)

- **Render free**: disk ephemeral, env vars durable → viable ONLY with
  on-chain-derived state (this design). Signing key would live in a Render env
  var — enabling real hosted spend is a separate permission decision.
- **Cloudflare Workers**: see the deployment notes — Workers + Durable Objects
  give single-writer serializable state per policy, which matches the
  check+reserve atomicity requirement natively.
