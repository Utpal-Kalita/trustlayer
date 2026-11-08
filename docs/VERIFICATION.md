# Verification evidence

All evidence below is reproducible. Local-validator signatures are not on
public explorers (the ledger is temporary); the commands regenerate them.

## 1. Policy engine unit tests (offline, no keys)

```
npm install
npm test
```

Expected: 10/10 PASS (allow/replay/at-cap/blocked/inflight/retry/expiry).

## 2. End-to-end Squads 2-of-2 proof (local validator, real program)

Boot a validator with the real Squads v4 program + config cloned from devnet:

```
solana-test-validator --url https://api.devnet.solana.com \
  --clone-upgradeable-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf \
  --clone BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr \
  --reset --quiet &
SOLANA_RPC=http://localhost:8899 TRUSTLAYER_API_KEY=... node src/api/server.js &
```

Then POST /api/propose with the x-trustlayer-key header.

Observed 2026-11-08 (Asia/Kolkata), fresh validator per run:

| Check | Result |
| --- | --- |
| Allowed 0.04 SOL to Vendor A | executed, sig `4q4QE7M7v8dacKrJ54dBSc9X...` |
| Identical 0.04 resubmitted | rejected: authorization already consumed (replay) |
| Allowed 0.05 SOL to Vendor A | executed, sig `51vbVE6x4bUfNtpmVymaoUgS...` |
| Vendor balance delta, confirmed commitment | exactly 90,000,000 lamports = 0.09 SOL = ledger sum |
| 3 concurrent 0.04 proposes (0.06 budget left) | 1 allowed, 2 rejected (atomic reservation) |
| Blocked destination (attacker) | rejected before any chain transaction |
| No x-trustlayer-key on /api/propose or PUT /api/policies | 401 |
| API restarted after 0.04 spent | 0.07 rejected: spent state persists via audit log |
| Gatekeeper alone (1-of-2) | Squads error 6008 InvalidProposalStatus |
| Blocked-by-policy proposal forced on-chain | Squads error 6004 Unauthorized |

## 3. What is NOT yet proven

- Public devnet execution (blocked on devnet SOL funding for the owner wallet).
- The hosted API (runs locally only; no public signing endpoint exists).

## 2026-11-08 hosted Squads devnet proof

Worker (Cloudflare, agent key only) proposed + approved 1-of-2 on the canonical
devnet multisig; independent gatekeeper approved 2-of-2 and executed. See
HOSTED-SIGNING-DESIGN.md addendum for sigs, the interim direct-signing
deviation, and its correction. Ledger derivation verified against squads
inner-instruction memos.
