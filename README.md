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
