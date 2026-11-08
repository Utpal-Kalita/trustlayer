# AI Interpretation Addendum (Module 7) — Groq

Status: live on devnet, 2026-11-08.

## Provider and model

- Provider: Groq (https://console.groq.com), account on the **Free plan** — no paid usage.
- Model: `openai/gpt-oss-20b` (verified present in the key's `/openai/v1/models` list).
- Strict JSON-schema structured output for the proposal; bounded input/output;
  temperature 0. On HTTP 429, any error, or incomplete output the route **fails
  closed**: no automatic retry, no fallback to another provider or model.

## Trust boundaries (unchanged from PRD)

The LLM only *interprets* a natural-language task into `{destination, amountSol}`
and *explains* the verdict. The deterministic policy engine decides ALLOW/BLOCK.
The LLM can never approve, sign, or execute. Execution remains Squads 2-of-2:
the agent key creates the proposal (1-of-2); the independent owner gatekeeper
verifies the on-chain content byte-exact and casts the second vote.

## Route contract

`POST /api/agent` on the API worker:

- Auth: `x-trustlayer-key` operator header (same key as `/api/execute`).
  Not public: there is no browser-facing AI endpoint, so no secret is proxied
  or embedded in the frontend. A public AI demo route would be a separate,
  explicitly approved decision.
- Body: `{"task": "<natural language payment task, max 500 chars>"}`.
- Rate limit: 30 interpretations/hour per IP (best-effort, per isolate).
- Response 200: `{ok, model, task, proposal: {destination, amountSol},
  verdict: {allow, reasons}, explanation, note}`.
- Response 422: interpretation failed shape validation or the model refused
  (`{ok:false, stage:'interpret'|'validate', error}`). No reservation is ever
  created on this route; `/api/execute` is the only path that proposes on-chain.

Driver: `node scripts/ai-agent.mjs "<task>" [--execute]`
(`--execute` still only creates the 1-of-2 proposal; the gatekeeper executes).

## Crash-consistency hardening

- The Durable Object persists the reservation **before** proposing on-chain, so a
  retried `execute` with the same `authId` is rejected as replay
  (`409 replay: authorization already executed or in flight`).
- The proposal's Squads transaction index is floored from the on-chain multisig
  account at execute time, so a Durable Object reset can never reuse an index
  that already exists on-chain (prevents duplicate proposals after ambiguity).
- Executed spend is re-derived from on-chain memos (`/api/refresh`), so the
  budget ledger self-heals from the chain after any restart.

Residual limit: if a proposal succeeds on-chain but the DO loses its
post-proposal record **and the proposal is never executed**, the pending
reservation is invisible to the ledger until resolved on-chain (executed or
rejected). The audit log and the on-chain proposal remain the source of truth;
`scripts/gatekeeper-execute.mjs <txIndex> check` inspects any pending index.

## End-to-end proof (devnet, 2026-11-08)

Natural-language task -> Groq proposal -> policy ALLOWED -> Squads proposal
(agent 1-of-2) -> gatekeeper byte-verified approve (2-of-2) -> executed:

1. "Pay Vendor A 0.01 SOL for the research summary" — txIndex 10, executed:
   https://explorer.solana.com/tx/65tdVyX4umGJitZjqsAGBdrcE71S4zkWACAV4gp6n9ZRgYrvuHDMq5cAdGeY9ixetakyVmasGnaivFiM4DwehhxW?cluster=devnet
2. "Pay Vendor A 0.01 SOL for the final demo milestone" — txIndex 11, executed:
   https://explorer.solana.com/tx/3LsgoE3LUR1mxaGARTFEH6W1GtcShSBaMP7j2Mbu2xyNEp9gk82ZCmVQzhmomU5UC2XNUpCSf1rcidrMwSv1FoP1?cluster=devnet

Blocked paths verified live with real inference: over-limit amount (0.5 SOL) and
non-allowlisted/blocked destination both BLOCKED by the deterministic engine
with correct reasons; no signature exists for blocked proposals.
