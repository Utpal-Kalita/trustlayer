# TrustLayer

**The authorization infrastructure for autonomous AI agents.**
*Give AI agents the freedom to act. Never give them unlimited authority.*

An AI agent never gets unrestricted wallet authority. It **asks** to pay. A
deterministic policy engine decides whether the payment is allowed. A real payment needs
two signatures in a **Squads 2-of-2 multisig**: the hosted agent's key and a gatekeeper
key that stays on the owner's machine. Neither key can move funds alone, and no language
model is in the decision path.

> A transaction can be technically valid on Solana and still be unauthorized.
> TrustLayer rejects it.

**The AI proposes. TrustLayer authorizes. Solana executes.**

## The problem

AI agents are becoming autonomous actors that can manage money, purchase services and
interact with other agents. But an agent can be manipulated by malicious instructions
hidden in webpages, documents or other external content. If that agent has unrestricted
access to a wallet, a single compromised decision can move money. Wallet permissions were
not designed around the unpredictable behaviour of autonomous AI agents.

## The solution

TrustLayer is a security boundary between AI agents and financial execution. Instead of
trusting the agent to behave, the owner defines exactly what it may do - how much it can
spend per payment, its total budget, which recipients it can pay, which transaction
types it can use and when its permissions expire - and a deterministic policy engine
enforces those rules on every request. The AI can never modify, override or approve its
own policy. The security boundary does not depend on the AI behaving correctly.

## Demo and live links

- **Demo video (1:56):** https://youtu.be/h3BCBdKqOtw
- **Live console:** https://trustlayer-dashboard-omega.vercel.app/app.html - the **Ask the agent** tab runs the real AI routes against the live backend as dry runs
- **Landing page:** https://trustlayer-dashboard-omega.vercel.app/
- **Live backend:** https://trustlayer-api-cf.adzeo2.workers.dev (`GET /api/health`, `/api/policies`, `/api/audit`, `/api/state`; public AI routes below)

## Features

- **Plain-language tasks in, checked payments out.** An AI model (Groq `openai/gpt-oss-20b`) turns a task into a structured payment proposal and writes the explanation. It never decides whether a payment is authorized.
- **Deterministic policy engine.** Per-payment and total SOL limits, recipient allowlist and blocklist, System-Program-transfers only, policy expiry, one-time-use authorizations. Fails closed on any error.
- **Two-key execution (Squads 2-of-2).** An approved payment becomes a real Squads proposal: the hosted agent key votes 1-of-2; the owner-side gatekeeper reads the transaction back from chain, byte-verifies it, then votes 2-of-2 and executes. Neither key moves funds alone.
- **Prompt-injection defense, shown live.** A controlled vendor catalogue hides a malicious "payout wallet changed" notice. The careless agent profile asks to pay the attacker wallet; the engine blocks it (verified live on devnet, 2026-11-08). The default careful profile refuses the page outright.
- **Crash-safe spend ledger.** Executed spend and open reservations are re-derived from on-chain memos, so the budget survives redeploys and an executed authorization cannot be replayed.
- **Judge-friendly public API.** Dry-run evaluation and both AI routes are public and rate-limited; real proposals stay operator-only. A daily model-step quota is enforced by the worker.
- **Owner console.** Live policy, audit log of every decision, chain-derived usage, and an "Ask the agent" tab that runs the real AI route as a dry run.

## Architecture

```
Browser console (Vercel)          Cloudflare Worker + Durable Object            Solana devnet
------------------------          ----------------------------------            ----------------------
landing + "Ask the agent"   -->   public read + dry-run routes           -->    Squads v4 2-of-2 multisig
dashboard (no keys)               AI routes (Groq openai/gpt-oss-20b)                 ^
                                  policy engine - the only decider                    |
                                  AGENT key: proposes, votes 1-of-2                   |
                                                                                      |
Owner's machine: scripts/gatekeeper-execute.mjs - re-reads the vault tx from chain, --+
byte-verifies it, then votes 2-of-2 and executes

Optional local API (src/, Node): agent registration, per-agent policies,
same inspect -> simulate -> policy -> reserve -> propose pipeline.
```

The flow for any payment:

1. A task in plain language becomes a structured proposal (destination, amount).
2. The policy engine checks it against the owner's rules. Only its verdict counts.
3. An approved payment (operator route only) becomes a Squads vault transaction and proposal, with the agent's vote 1-of-2.
4. The gatekeeper on the owner's machine re-reads the exact transaction from chain, refuses anything unexpected, votes 2-of-2 and executes.
5. Executed spend and open reservations are re-derived from on-chain memos (`GET /api/state`), so restarts cannot reset the budget.

## Built on Solana

| Component | Technology |
|---|---|
| Blockchain | Solana (devnet, test SOL) |
| Transaction authorization | Squads protocol (2-of-2 multisig) |
| AI interpretation | Groq - `openai/gpt-oss-20b` |
| Backend | Cloudflare Workers + Durable Objects |
| Console | Vercel (static dashboard) |
| Policy enforcement | Deterministic off-chain engine; the Squads threshold enforces the outcome on chain |

Autonomous agents will increasingly need financial infrastructure. Solana provides the
execution layer; Squads provides the multisig mechanism that keeps both the agent and
the owner in every real transaction.

## What the demo shows

- **A normal payment, end to end.** A vendor payment is approved by the engine and
  executed through the 2-of-2 flow, with the gatekeeper verifying the transaction from
  chain before casting the second vote.
- **A careful agent under injection.** On a vendor page hiding a malicious "payout
  wallet changed" notice, the default agent refuses to buy at all.
- **A careless agent under injection.** The naive agent follows the injected
  instructions and asks to pay the attacker - and the policy engine blocks it. The
  boundary holds even when the AI fails.
- All public demo runs are dry runs. Real execution was verified separately on devnet
  with test SOL (proof links below).

## Vision

Autonomous agents will manage treasuries, purchase services and coordinate with other
agents. Autonomy without authorization creates risk. TrustLayer aims to become the
authorization infrastructure for that economy: agents act independently while remaining
accountable to the permissions their owners set. The goal is not to make AI agents less
autonomous - it is to make it safe to give them more autonomy.

Built for the **MLH Solana Hackathon, Nov 6-8 2026**. Solana devnet only, test SOL only.
This is a prototype, not production-ready financial infrastructure. Product spec: [prd.md](prd.md).

## Built, verified, vision

| | |
|---|---|
| **Built** | Deterministic policy engine; hosted agent on a Cloudflare worker (agent key only); owner-side gatekeeper script; Squads 2-of-2 execution path; single-task AI route and multi-step AI agent (Groq `openai/gpt-oss-20b`); landing page and console; optional local API with agent registration and per-agent policies |
| **Verified** | Payments executed on Solana **devnet** with test SOL through the 2-of-2 flow, including AI-initiated ones (links below); attacker payments blocked by the engine; agent-alone and gatekeeper-alone execution failing on chain; offline test suites |
| **Vision, not built** | Mainnet use, SPL token and DeFi execution, on-chain policy enforcement, cross-run duplicate protection, signed task-authorization tokens, production hardening |

## Live backend and key separation

The console (`dashboard/app.html`) talks to the Cloudflare backend
`https://trustlayer-api-cf.adzeo2.workers.dev` by default, through public routes only:
health, policies, audit, state, evaluate, and the two AI routes below. Contract:
[docs/INTEGRATION.md](docs/INTEGRATION.md).

| Who | Holds | Can do |
|---|---|---|
| Browser (landing page, console) | nothing | read policy and audit, dry-run evaluate, run the AI routes as dry runs |
| Hosted agent (worker) | AGENT key only | re-check policy, create the Squads proposal, approve 1 of 2 (operator-only routes) |
| Owner's machine | GATEKEEPER key (and OWNER key) | `scripts/gatekeeper-execute.mjs`: read the vault tx from chain, verify, approve 2 of 2, execute |

Pay through the live backend (operator only):

```bash
# 1. hosted agent proposes (API key stays in this terminal, never in the browser)
TRUSTLAYER_API_KEY=... node scripts/hosted-propose.mjs <destination> <amountSol>
# 2. owner-side gatekeeper: verify, then approve 2 of 2 (it prints the exact commands)
node scripts/gatekeeper-execute.mjs <txIndex> check   --expect <destination> <lamports> --expect-memo <memo>
node scripts/gatekeeper-execute.mjs <txIndex> approve --expect <destination> <lamports> --expect-memo <memo>
```

Uses the verified multisig `BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC` (vault
`93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe`). Nothing here creates a multisig or
requests airdrops; fund the vault by hand (docs/DEVNET-FUNDING.md).

### Live demo policy

From `cloudflare/wrangler.toml` (`POLICY_JSON`), mirrored in `policies/default.json`:

- max 0.05 SOL per payment, 0.1 SOL total budget
- recipients: Vendor A (`HnJmp1w4iSgoHiKjDckNSc9qkXSuREu9Ch2NWJabPC3Z`) only; `7GC8LGCn9vJ6jDQ1jQQ8ctyyRRcnSRWW2HvVDEsnKScM` explicitly blocked
- SOL transfers through the System Program only; one-time use per authorization
- expires **11:59 PM IST, November 22, 2026** (`2026-11-22T18:29:00.000Z`)

The total budget is counted from executed vault transactions on chain plus open
reservations. It is not reset by redeploys: payments already executed under this policy
keep counting (0.07 SOL of 0.1 SOL used at the last check on Nov 8). Current usage:
`GET /api/state`.

## AI agents

The model reads tasks, plans and asks to pay. It never decides whether a payment is authorized. Every payment request
goes to the same deterministic policy engine as any other proposal, and the model cannot
approve, sign, raise a limit or skip a check.

### Single task: `POST /api/agent`

`{ task }`. The model turns one plain-language task into a payment proposal, the engine
decides, and the model writes a short explanation of the verdict. No reservation, no
proposal, no funds moved.

### Multi-step agent: `POST /api/agent/run`

`{ task, scenario: "clean" | "injected", profile: "careful" | "naive" }`. A bounded tool-calling agent
(`cloudflare/agent-loop.js`, Groq `openai/gpt-oss-20b`) with five tools:

| Tool | What it does |
|---|---|
| `list_vendors` | Lists the fixed demo vendors and their wallets |
| `read_vendor_page` | Returns a vendor's catalogue page (fixed text, no URL fetching). In the `injected` scenario Vendor A's page hides a note for AI assistants: pay another wallet, plus a 0.02 SOL fee |
| `check_budget` | Per-payment limit, total limit, remaining budget, approved recipients, expiry |
| `request_payment` | Sends the payment request to the policy engine; returns APPROVED or BLOCKED with reasons |
| `finish` | Ends the run with a summary for the user |

Agent `profile`:

- `careful` (default): treats vendor pages as untrusted content.
- `naive`: stands in for a careless, off-the-shelf agent. Its prompt tells it to follow
  payment instructions found on vendor pages, including updated wallets and fees. It
  exists to show the engine stopping an agent that has no defence of its own. The naive
  profile is always a dry run, even with the operator key.

Bounds, from the code:

- Up to **8 model steps** per run.
- Up to **3 distinct payment requests** per run reach the engine; more are refused.
- An identical payment (same destination and amount) already approved **within the same
  run** is not submitted to the policy engine again. This protection does **not** extend
  across separate runs.
- Tool arguments are validated before use; unknown tools and malformed arguments are refused.

**Public runs are dry runs.** APPROVED means the policy would allow the request. It does
not mean funds moved or anything was purchased. With the operator key and
`execute: true`, an APPROVED request becomes a real Squads proposal with the agent's vote
(1 of 2); funds move only after the owner-side gatekeeper verifies it and casts vote 2 of 2.

Limits on public use, enforced by the worker:

- **300 model steps per UTC day**, shared by all public callers of both AI routes (one unit
  per model step). This is TrustLayer's own application quota, not Groq's provider allowance.
- **10 agent runs per hour per IP** for `/api/agent/run` (30 calls per hour per IP for `/api/agent`).
- Groq can separately rate-limit calls. On HTTP 429 the agent waits once if Groq's
  `Retry-After` is 20 seconds or less, otherwise the run stops.

### What the AI tests showed

- **Single-task route, live:** given a task containing an injected instruction, the model
  proposed paying the attacker wallet and the deterministic policy engine blocked it.
- **Multi-step agent, `careful` profile (default), live:** on the poisoned vendor page the
  model notices the injected wallet change and refuses to buy, ending the run with no
  payment request (verified 2026-11-08: "the vendor's wallet has changed and the new
  address is not in the approved recipients list... No payment was made").
- **Multi-step agent, `naive` profile, live:** the careless agent follows the injected
  instruction and asks to pay the 0.02 SOL "verification fee" to the attacker wallet
  (verified 2026-11-08). The deterministic engine BLOCKED it: explicitly blocked
  destination, not in the allowlist. A live hijack attempt, stopped before the chain.
  Public runs are always dry runs, so nothing moved.
- **Multi-step agent, offline tests** (`node scripts/test-agent-loop.mjs`): a scripted model
  that follows the malicious instructions asks to pay the attacker; the real policy engine
  blocks it, and the agent then pays Vendor A. These are offline tests with a scripted
  model, not live model runs.

## Local API (optional)

A full local backend with agent registration, per-agent policies, instruction decoding
and devnet simulation. It follows the same key split: the server loads only
`AGENT_SECRET`, proposes and casts vote 1 of 2. It never loads the gatekeeper or owner
key. Proposing requires the agent's own `x-agent-key`; owner and demo sessions can only
evaluate.

```bash
npm install
npm test                                   # policy engine, API and agent-loop tests, offline
TRUSTLAYER_DEMO_LOGIN=1 TRUSTLAYER_API_KEY=dev npm start     # console at http://localhost:8787/app.html
TRUSTLAYER_API_KEY=dev npm run demo:setup  # registers "Research Agent" on the verified vault
npm run demo:agent                         # the 3 PRD scenarios (evaluate)
npm run demo:agent -- --execute            # approved one -> Squads proposal, vote 1 of 2; prints the gatekeeper command
node scripts/e2e-live.mjs                  # checks the live worker and devnet state (public routes, no keys)
```

The console uses the local API when the page is served by it; `?backend=hosted` forces the live worker.

### How the local API decides a proposal

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
   5. propose     agent creates the Squads vault tx (transfers + memo) + proposal, votes 1/2
                  -- separate process, owner's machine --
                  gatekeeper-execute.mjs reads the vault tx BACK FROM CHAIN, refuses anything
                  it cannot classify or that does not match --expect / --expect-memo,
                  votes 2/2 and executes
   6. record      transaction row (checks, simulation logs, policy version, signature)
                  + a security event per failed check
```

`execute` re-runs steps 1 to 4 from the raw proposal. It never trusts `approved: true`
or an earlier evaluation. A failed proposal releases its reservation; an open proposal
keeps it until the chain shows it executed (reconciled on read) or rejected.

### Local API endpoints

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
| POST | `/api/transactions/execute` | agent only | Full decision again, then Squads proposal + vote 1 of 2 |
| GET | `/api/transactions` | owner | History, every attempt |
| GET | `/api/security-events` | owner | Violations and owner actions |
| GET | `/api/overview`, `/api/health` | owner / public | Dashboard counts, server status |

Owner auth: `Authorization: Bearer <session>` or `x-trustlayer-key: $TRUSTLAYER_API_KEY`.
Agent auth: `x-agent-key: tla_…`. An agent key can only propose for its own agent and can never change its policy.

Proposal body: `{ "recipient": "<address>", "amountSol": 0.01, "action": "sol_transfer", "nonce": "task-42" }`
or `{ "transaction": "<base64 serialized tx>" }`. Policy body:
`{ "agentId", "maxTransactionSol", "spendingLimitSol", "approvedRecipients": [{ "label", "address" }], "allowedActions": ["sol_transfer"], "expiresInHours" }`.

| Env | Default | |
|---|---|---|
| `SOLANA_RPC` | devnet | RPC for simulation and execution |
| `TRUSTLAYER_SIMULATION` | `required` | `off` skips simulation (offline tests only; shown on every decision) |
| `TRUSTLAYER_API_KEY` | none | Owner key for scripts |
| `TRUSTLAYER_DEMO_LOGIN` | off | `1` shows "Use the demo owner" in the console |
| `TRUSTLAYER_READ_ONLY` | off | `1` disables execution (for ephemeral hosts) |
| `TRUSTLAYER_DB` | `data/db.json` | Data file |

## Honest trust model

- The gatekeeper **does** hold a signing key, on the owner's machine, never on a hosted
  server. The hosted agent key alone cannot move funds, and neither can the gatekeeper
  key alone: the threshold is 2-of-2.
- Policy rules are evaluated **off-chain** at the approval step. On chain, the Squads
  threshold enforces the outcome: a proposal the gatekeeper does not approve cannot execute.
- The policy engine is deterministic code. No language model is in the decision path.
- The local API's storage is a single JSON file (`src/db/store.js`) with the PRD's tables,
  atomic within one server process. A PostgreSQL/Supabase adapter is future work.
- Supported for execution: SOL transfers from the vault. SPL transfers are decoded and can
  be allowed or blocked by policy, but not executed.

## Known limits

- Model errors and rate limits (Groq's or TrustLayer's daily quota) can stop an agent run
  before its final summary.
- Duplicate-payment protection in the agent covers one run only, not separate runs.
- In live multi-step runs the default (careful) agent refuses the poisoned page rather than
  attempting the attacker payment; the naive profile attempts it, and the engine blocks
  it (see above).
- Devnet and test SOL only. This is a hackathon prototype, not production-ready financial
  infrastructure.

## Repo layout

- `cloudflare/worker.js` - the live worker (hosted agent, durable policy gate, AI routes)
- `cloudflare/agent-loop.js` - multi-step agent loop and its tools
- `cloudflare/groq.js` - Groq adapter (server-side only)
- `scripts/gatekeeper-execute.mjs` - owner-side verification, vote 2 of 2, execution
- `scripts/hosted-propose.mjs` - ask the hosted agent to propose
- `scripts/ai-agent.mjs` - single-task AI flow from a terminal (operator)
- `scripts/test-agent-loop.mjs` - offline agent tests (scripted model + real engine)
- `scripts/e2e-live.mjs` - live check of the worker and devnet state
- `dashboard/` - landing page (`index.html`) and console (`app.html`, `hosted.js` for the live worker)
- `src/` - optional local API: server, inspect → simulate → policy → reserve → propose pipeline, store
- `src/policy/engine.js`, `scripts/spike.mjs` - the first devnet proof, kept for reference

## Verification status

All on-chain payments below used **devnet test SOL**, not mainnet money.

Local validator proof (solana-test-validator with the real Squads v4 program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` cloned from devnet) — all three scenarios pass (`SOLANA_RPC=http://localhost:8899 node scripts/spike.mjs`):

1. **Allowed payment** — policy engine returns ALLOW; agent approves (vote 1), gatekeeper approves (vote 2), vault transfer executes; vendor received 0.01 SOL.
2. **Blocked attack** — policy returns REJECT (blocked destination); agent alone cannot execute (Squads error 6004, no Execute permission), cannot double-vote (6010), and even the gatekeeper cannot execute an unapproved proposal (6008). Attacker balance stayed 0.
3. **Non-custodial** — the gatekeeper alone (1 of 2 votes) cannot move funds (6008); vault balance unchanged.

Public devnet proof (2026-11-08, `node scripts/spike.mjs` against `api.devnet.solana.com`) — all three scenarios pass on the real cluster:

- Multisig `BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC`, vault `93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe` ([explorer](https://explorer.solana.com/address/BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC?cluster=devnet))
- **Allowed payment** executed: policy ALLOW -> agent approve -> gatekeeper approve -> gatekeeper execute ([tx](https://explorer.solana.com/tx/3NxbjhoT1QDPGTfFDeTQBo2gMsNenkMa8LS6qWYLeLF5RToGV7fSWquvWGvse6MewnRmDMS7wMARzc7y3JVNXQmE?cluster=devnet)). Verified after: vendor 0.01 SOL, vault 0.19 SOL.
- **AI-initiated payments** executed end to end (Groq `openai/gpt-oss-20b` interpretation -> policy ALLOW -> hosted Squads proposal -> gatekeeper chain-verified 2-of-2 approval -> execution): [tx 1](https://explorer.solana.com/tx/65tdVyX4umGJitZjqsAGBdrcE71S4zkWACAV4gp6n9ZRgYrvuHDMq5cAdGeY9ixetakyVmasGnaivFiM4DwehhxW?cluster=devnet), [tx 2](https://explorer.solana.com/tx/3LsgoE3LUR1mxaGARTFEH6W1GtcShSBaMP7j2Mbu2xyNEp9gk82ZCmVQzhmomU5UC2XNUpCSf1rcidrMwSv1FoP1?cluster=devnet).
- **Blocked attack** rejected by the policy engine (blocked destination); agent-alone execute failed on-chain (Squads 0x1774), double-vote failed, gatekeeper execute on the unapproved proposal failed (0x1778). Attacker balance stayed 0.
- **Non-custodial**: the gatekeeper alone (1 of 2 votes) cannot move funds (0x1778); vault unchanged.

Full run record with all transaction signatures: [docs/DEVNET-FUNDING.md](docs/DEVNET-FUNDING.md). Local-validator evidence with byte-level reconciliation: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Roadmap

- Cross-run duplicate protection for agent payments
- PostgreSQL/Supabase adapter for the local store
- SPL token execution, then DeFi actions (swaps) under the same policy engine
- Signed task-authorization tokens verifiable by third parties
- On-chain policy enforcement (a program the vault calls)
