# TrustLayer

**The permission layer for AI agents.**
*Autonomous agents. Limited authority. Verifiable execution.*

An AI agent never gets unrestricted wallet authority. It **proposes** Solana
transactions. TrustLayer **decodes** every instruction, **simulates** the
transaction against live devnet state and **checks** it against the owner's policy.
Only then does the TrustLayer gatekeeper cast the second vote in a **Squads 2-of-2
multisig** (agent key + gatekeeper key). Neither key can move funds alone.

> A transaction can be technically valid on Solana and still be unauthorized.
> TrustLayer rejects it.

Built for the **MLH Solana Hackathon, Nov 6-8 2026**. Solana devnet only. Product spec: [prd.md](prd.md).

## Quick start

```bash
npm install
npm test                                   # policy engine + 40 API tests, offline

# console only (evaluate, no signing): open http://localhost:8787
TRUSTLAYER_DEMO_LOGIN=1 TRUSTLAYER_API_KEY=dev npm start

# full devnet flow (signing through Squads)
node scripts/genkeys.mjs                   # devnet keypairs -> .env (gitignored); fund the OWNER key
TRUSTLAYER_DEMO_LOGIN=1 TRUSTLAYER_API_KEY=dev npm start
TRUSTLAYER_API_KEY=dev npm run demo:setup  # multisig + vault + "Research Agent" with the PRD policy
npm run demo:agent                         # the agent runs the 3 PRD demo scenarios (evaluate)
npm run demo:agent -- --execute            # ...and executes the approved one on devnet
```

- `/` is the landing page. `/app.html` is the console: sign in with Phantom (it signs a
  one-time message), or with the demo owner when `TRUSTLAYER_DEMO_LOGIN=1`.
- In the console you can register agents, edit their permissions, deactivate them and
  rotate their keys. You can propose transactions, read the history with the reason for
  every check, and see security events.

## How a proposal is decided

```
agent --x-agent-key--> POST /api/transactions/{evaluate|execute}
   1. inspect     decode EVERY instruction (structured payment or serialized legacy/v0 tx);
                  anything not provably a SOL transfer from the agent's vault -> unsupported
   2. simulate    simulateTransaction of the vault transfer against devnet (fail closed)
   3. policy      deterministic checks, all reported:
                  agent active · permission not expired · decodable · sender is the vault ·
                  action allowed · per-tx limit · cumulative limit · recipient allowlisted ·
                  nonce unused (optional) · simulation succeeded
   4. reserve     spend reserved in the same synchronous step as the check (no race)
   5. execute     agent creates the Squads vault tx + proposal, votes 1/2
                  gatekeeper reads the vault tx BACK FROM CHAIN, refuses unless it matches
                  the approved transfers exactly, votes 2/2
                  the real Squads execute instruction is simulated, then sent
   6. record      transaction row (checks, simulation logs, policy version, signature)
                  + a security event per failed check
```

`execute` re-runs steps 1 to 4 from the raw proposal. It never trusts `approved: true`
or an earlier evaluation. A failed execution releases its reservation.

## API

| Method | Endpoint | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/challenge`, `/api/auth/verify` | owner | Wallet sign-in (ed25519 signature of a one-time message) |
| POST | `/api/agents` | owner | Register an agent (optionally with its policy); returns the agent key **once** |
| GET | `/api/agents`, `/api/agents/:id` | owner | Agents with their policy and spend |
| PATCH | `/api/agents/:id` | owner | Rename, change vault, `status: active\|inactive` |
| POST | `/api/agents/:id/rotate-key` | owner | Revoke the agent key and issue a new one |
| POST | `/api/policies` | owner | Create the agent's policy (replaces the current one) |
| GET | `/api/policies/:agentId` | owner | The agent's active policy and committed spend |
| PATCH | `/api/policies/:id` | owner | Update; bumps the version, applies to the next proposal |
| POST | `/api/transactions/evaluate` | agent / owner | Full decision, nothing signed |
| POST | `/api/transactions/execute` | agent / owner | Full decision again, then Squads execution |
| GET | `/api/transactions` | owner | History, every attempt |
| GET | `/api/security-events` | owner | Violations and owner actions |
| GET | `/api/overview`, `/api/health` | owner / public | Dashboard counts, server status |

Owner auth: `Authorization: Bearer <session>` or `x-trustlayer-key: $TRUSTLAYER_API_KEY`.
Agent auth: `x-agent-key: tla_…`. An agent key can only propose for its own agent and can never change its policy.

Proposal body: `{ "recipient": "<address>", "amountSol": 0.01, "action": "sol_transfer", "nonce": "task-42" }`
or `{ "transaction": "<base64 serialized tx>" }`. Policy body:
`{ "agentId", "maxTransactionSol", "spendingLimitSol", "approvedRecipients": [{ "label", "address" }], "allowedActions": ["sol_transfer"], "expiresInHours" }`.

### Configuration

| Env | Default | |
|---|---|---|
| `SOLANA_RPC` | devnet | RPC for simulation and execution |
| `TRUSTLAYER_SIMULATION` | `required` | `off` skips simulation (offline tests only; shown on every decision) |
| `TRUSTLAYER_API_KEY` | none | Owner key for scripts |
| `TRUSTLAYER_DEMO_LOGIN` | off | `1` shows "Use the demo owner" in the console |
| `TRUSTLAYER_READ_ONLY` | off | `1` disables execution (for ephemeral hosts) |
| `TRUSTLAYER_DB` | `data/db.json` | Data file |

## Honest trust model

- The gatekeeper **does** hold a signing key. It cannot move funds by itself: the
  threshold is 2-of-2, so TrustLayer can only *block*, never *take*. New multisigs make
  the owner the Squads config authority, so the owner can revoke or replace the members.
- Policy rules are evaluated **off-chain** at the approval step. On chain, the Squads
  threshold enforces the outcome: a proposal the gatekeeper does not approve cannot execute.
- The policy engine is deterministic code. No LLM is in the decision path.
- Storage is a single JSON file (`src/db/store.js`) with the PRD's tables. It is atomic
  within one server process. The schema maps 1:1 onto PostgreSQL/Supabase, but swapping
  the adapter is future work.
- Supported for execution: SOL transfers from the agent's vault. SPL transfers are
  decoded and can be allowed or blocked by policy, but not yet executed.

## Repo layout

- `src/api/server.js` - HTTP API + static host
- `src/service.js` - inspect → simulate → policy → reserve → execute pipeline
- `src/inspect/` - instruction decoder, devnet simulation
- `src/policy/checks.js` - deterministic policy checks
- `src/db/store.js` - data store
- `src/onchain.js` - Squads multisig + gatekeeper-verified execution
- `dashboard/` - landing page (`index.html`) and console (`app.html`)
- `scripts/` - tests, demo setup, demo agent, devnet spike
- `src/policy/engine.js`, `scripts/spike.mjs`, `cloudflare/` - the first devnet proof and the earlier single-policy engine, kept for reference

## Verification status

Local validator proof (solana-test-validator with the real Squads v4 program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` cloned from devnet) — all three scenarios pass (`SOLANA_RPC=http://localhost:8899 node scripts/spike.mjs`):

1. **Allowed payment** — policy engine returns ALLOW; agent approves (vote 1), gatekeeper approves (vote 2), vault transfer executes; vendor received 0.01 SOL.
2. **Blocked attack** — policy returns REJECT (blocked destination); agent alone cannot execute (Squads error 6004, no Execute permission), cannot double-vote (6010), and even the gatekeeper cannot execute an unapproved proposal (6008). Attacker balance stayed 0.
3. **Non-custodial** — the gatekeeper alone (1 of 2 votes) cannot move funds (6008); vault balance unchanged.

Public devnet proof (2026-11-08, `node scripts/spike.mjs` against `api.devnet.solana.com`) — all three scenarios pass on the real cluster:

- Multisig `BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC`, vault `93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe` ([explorer](https://explorer.solana.com/address/BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC?cluster=devnet))
- **Allowed payment** executed: policy ALLOW -> agent approve -> gatekeeper approve -> gatekeeper execute ([tx](https://explorer.solana.com/tx/3NxbjhoT1QDPGTfFDeTQBo2gMsNenkMa8LS6qWYLeLF5RToGV7fSWquvWGvse6MewnRmDMS7wMARzc7y3JVNXQmE?cluster=devnet)). Verified after: vendor 0.01 SOL, vault 0.19 SOL.
- **Blocked attack** rejected by the policy engine (blocked destination); agent-alone execute failed on-chain (Squads 0x1774), double-vote failed, gatekeeper execute on the unapproved proposal failed (0x1778). Attacker balance stayed 0.
- **Non-custodial**: the gatekeeper alone (1 of 2 votes) cannot move funds (0x1778); vault unchanged.

Full run record with all transaction signatures: [docs/DEVNET-FUNDING.md](docs/DEVNET-FUNDING.md). Local-validator evidence with byte-level reconciliation: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Roadmap

- PostgreSQL/Supabase adapter for the store
- SPL token execution, more instruction types
- Signed task-authorization tokens verifiable by third parties
- On-chain policy enforcement (a program the vault calls)
