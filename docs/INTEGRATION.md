# TrustLayer Integration Contract

Authoritative notes for wiring any frontend or console backend to the live, verified TrustLayer backend on Solana devnet. Added by the backend workstream; does not change any redesign code.

## Live backend

`https://trustlayer-api-cf.adzeo2.workers.dev` (Cloudflare worker + Durable Object).

Public (CORS open):
- `GET /api/health`
- `GET /api/policies` - the current policy
- `GET /api/audit` - recorded evaluations/decisions
- `GET /api/state` - executed spend, inflight reservations (chain-derived)
- `GET|POST /api/refresh` - re-derive state from chain (idempotent, additive only)
- `POST /api/evaluate` body `{destination, amountSol}` -> `{allow, reasons[]}` - dry-run policy verdict, never moves funds

Key-gated (header `x-trustlayer-key`, 401 otherwise):
- `POST /api/execute` / `POST /api/propose` - create the real Squads vault transaction + proposal; the hosted agent key signs approval 1-of-2
- `POST /api/cancel` - releases a pending reservation after an on-chain rejection only; never creates anything

The production dashboard (main branch) already uses the public routes for policy display, audit log, and evaluation. Reuse those calls.

## Hard requirements

1. **Key separation**: only the AGENT key is hosted. GATEKEEPER and OWNER keys must never be on any hosted server. The agent key alone cannot move funds (2-of-2 multisig). Do not load all three keys into one deployable service - that makes the multisig ceremonial.
2. **Gatekeeper is owner-side by design**: `node scripts/gatekeeper-execute.mjs <txIndex> [approve|reject|check] [--expect <destination> <lamports>] [--expect-memo <memo>]`. It reads the proposed vault transaction back from chain, decodes and prints every inner SOL transfer and memo, refuses anything it cannot fully classify, and only then votes 2-of-2 and executes. It never creates proposals.
3. **Reuse the verified multisig**: `BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC`, vault `93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe` (devnet). Executed proof is in `docs/VERIFICATION.md` on main. Do not create a new multisig; do not automate airdrops.
4. **No secrets in browser code**: the UI must never hold `x-trustlayer-key` or any keypair. Browser flows use public evaluate only; real execution stays owner-run (requirement 2). Do not wire execution to an open demo sign-in.
5. **Merge care**: this branch forked before the latest main commits. Keep main's `cloudflare/` (worker + wrangler), `docs/VERIFICATION.md`, `docs/HOSTED-SIGNING-DESIGN.md`, `scripts/gatekeeper-execute.mjs`, and the dashboard's worker `API_BASE`.
6. **Scope**: devnet only, no real funds, no "keyless" or "fully on-chain enforcement" claims.
