# TrustLayer

**The Permission Layer for AI Agents.**
*Autonomous agents. Limited authority. Verifiable execution.*

TrustLayer is a programmable authorization layer that sits between an AI agent and a
Solana wallet. Agents never get unrestricted spending authority: they **propose**
transactions, TrustLayer **evaluates** them against a deterministic policy set by the
owner, and only approved transactions are signed by the TrustLayer gatekeeper inside a
**Squads 2-of-2 multisig** (agent key + gatekeeper key).

> A transaction can be technically valid on Solana and still be unauthorized.
> TrustLayer rejects it.

Built for the **MLH Solana Hackathon, Nov 6-8, 2026**. Solana Devnet only.

## How it works

```
AI Agent                TrustLayer                          Solana
   |                        |                                  |
   |-- propose tx --------->|                                  |
   |                        |-- decode instructions            |
   |                        |-- simulate (devnet RPC)          |
   |                        |-- policy engine:                 |
   |                        |    recipient allowlist           |
   |                        |    per-tx limit                  |
   |                        |    cumulative spending cap       |
   |                        |    allowed actions, expiry       |
   |                        |                                  |
   |              ALLOW -----+----- BLOCK                       |
   |                |        |        |                        |
   |                v        |        v                        |
   |     gatekeeper approves |  record reason, no signature    |
   |     in Squads 2-of-2    |  (tx can never execute)         |
   |                v        |                                 |
   |----------- execution on devnet -------------------------->|
```

## Honest trust model

We deliberately do **not** claim "keyless" or "fully on-chain policy enforcement":

- The gatekeeper **does** hold a signing key. What it cannot do is move funds by
  itself: the multisig threshold is 2-of-2, so neither the agent nor the gatekeeper
  can execute unilaterally. TrustLayer can only *block*, never *take*.
- Policy rules (limits, allowlists, expiry) are evaluated **off-chain** at the
  approval step. On-chain, the Squads threshold enforces the outcome: a proposal the
  gatekeeper refuses to approve cannot reach execution.
- The policy engine is deterministic code. An LLM may *explain* a decision in plain
  English, but it can never change a verdict.

### Authorization semantics

- The demo policy sets `oneTimeUse: true`: each authorization is bound to the
  exact transaction content (program, action, destination, integer lamports) and
  the policy version. Once executed, that same authorization cannot be replayed;
  a concurrent duplicate is rejected as in-flight; a failed attempt releases the
  authorization so a retry works.
- All budget arithmetic is integer lamports, so an exactly-at-cap request is
  allowed and one lamport over is rejected.
- Repeating an identical payment that was already consumed requires explicit
  owner re-authorization: bump the policy version (`node scripts/issue-policy.mjs --bump`)
  or update the policy via the authenticated `PUT /api/policies`. It is never
  silently possible.
- Scope note: this is per-transaction one-time authorization, not a claim of
  universal replay protection for every possible flow. Cryptographically signed
  task-authorization tokens (verifiable by third parties) are future work - see
  the roadmap.

### Policy editing

`dashboard/policy.html` is a basic editor for the JSON policy. Saving sends
`PUT /api/policies` to the locally running API, which rewrites
`policies/default.json` and reloads it live - it changes what future proposals
are evaluated against, nothing on-chain, and it requires the same
`x-trustlayer-key` as the signing endpoint. It is not a full registration or
multi-user config UI (that is roadmap).

## Demo scenario (devnet)

1. Owner registers "Research Agent" with: max 0.05 SOL/tx, 0.1 SOL total budget,
   recipient allowlist = Vendor A, SOL transfers only, 2-hour expiry.
2. **Legitimate payment** (0.01 SOL to Vendor A): passes all checks, gatekeeper
   approves, executes on devnet. Explorer link shown.
3. **Oversized payment** (0.5 SOL): BLOCKED - exceeds per-transaction limit.
4. **Prompt-injection attack** (0.01 SOL to unknown wallet): BLOCKED - recipient not
   in the allowlist. The agent cannot execute it on its own; an execution attempt
   signed only by the agent fails on-chain.

See `docs/PRD.md` for the full product requirements document.

## Repo layout

- `docs/PRD.md` - full product requirements document (the build spec)
- `scripts/spike.mjs` - devnet proof: propose -> gatekeeper approve -> execute, and
  proof that agent-alone and gatekeeper-alone execution both fail
- `src/` - policy engine, transaction inspector, Squads executor, API (in progress)
- `web/` - owner dashboard (in progress)

## Development

Devnet-only demo keys are generated locally (`node scripts/genkeys.mjs`, written to
`.env`, which is gitignored). No real funds anywhere. Never commit keys.

```bash
npm install
node scripts/genkeys.mjs   # creates .env with fresh devnet keypairs
node scripts/spike.mjs     # runs the on-chain proof on devnet
```


## Verification status

Local validator proof (solana-test-validator with the real Squads v4 program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` cloned from devnet) — all three scenarios pass (`SOLANA_RPC=http://localhost:8899 node scripts/spike.mjs`):

1. **Allowed payment** — policy engine returns ALLOW; agent approves (vote 1), gatekeeper approves (vote 2), vault transfer executes; vendor received 0.01 SOL.
2. **Blocked attack** — policy returns REJECT (blocked destination); agent alone cannot execute (Squads error 6004, no Execute permission), cannot double-vote (6010), and even the gatekeeper cannot execute an unapproved proposal (6008). Attacker balance stayed 0.
3. **Non-custodial** — the gatekeeper alone (1 of 2 votes) cannot move funds (6008); vault balance unchanged.

Devnet run with public explorer links: pending devnet SOL (public RPC faucets are closed; fund the creator wallet at https://faucet.solana.com, then run `node scripts/spike.mjs`).

## Roadmap (future work)

- Cryptographically signed task-authorization tokens: an authorization artifact
  bound to task ID, agent, recipient, cap, nonce and expiry that third parties
  can verify, extending today's content-bound one-time authorizations.
- Public devnet execution (blocked only by devnet SOL funding).
- Full registration / multi-user configuration UI (today: JSON policy + the
  basic authenticated editor at dashboard/policy.html).
- Product-delivery verification (proof the vendor delivered, not just that the
  executed transaction matches the authorized one).
