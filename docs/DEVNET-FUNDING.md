# Devnet funding evidence (2026-11-08)

TrustLayer's proof currently runs on a local validator (see VERIFICATION.md).
Public-devnet execution is blocked only by obtaining test SOL: as of
2026-11-08 the devnet RPC faucet is closed cluster-wide and every checkable
PoW-faucet reward pool is empty. This file records the evidence.

## 1. RPC airdrop: closed cluster-wide

`requestAirdrop` on `https://api.devnet.solana.com` returns:

```
{"code": 410, "message": "The RPC faucet is closed on this cluster. Request test SOL at https://faucet.solana.com"}
```

Same on `https://devnet.rpcpool.com`. This is a cluster-level closure, not a
per-IP rate limit.

## 2. PoW faucet (devnet-pow): specs exist, reward pools empty

faucet.solana.com itself points agents at programmatic routes, including the
proof-of-work faucet:

- Crate: https://crates.io/crates/devnet-pow (v0.1.4, MIT, author jarry-xiao)
- Source: https://github.com/jarry-xiao/proof-of-work-faucet
- On-chain program: `PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL` (devnet)

Payout semantics (from `programs/proof-of-work-faucet/src/lib.rs`): the
`airdrop` instruction transfers `spec.amount.min(source.lamports())` from the
spec's `source` PDA directly to the miner's payer keypair. The `source` PDA is
the only treasury for that spec. After the transfer it creates a receipt
account funded by the payer, so mining against an empty pool pays 0 and costs
the miner rent.

Checked at devnet slot 519946175 (2026-11-08T07:30:19Z) via PDA derivation:

| difficulty | reward | spec PDA | source (reward pool) PDA | pool balance |
|---|---|---|---|---|
| 3 | 0.02 SOL | `7QR2Vrhedq3PKUkT25hUaoXCwXr82i6BRds5ZXhfcyzw` | `6yvwhesLJeE8fNWviosRoUtBP3VFUXE7SEhSP9fFRJ3Z` | 0 lamports |
| 3 | 0.05 SOL | `5x5WQScCCaCvFmJRFUUmUf7kFaSr9m4kGhKNhu5S7EWU` | `AKDUUyPuHjwGqsX865vWKN6nY3SebNu7FsSoYysDzhDJ` | 0 lamports |
| 4 | 0.05 SOL | `8txQjU7YkBkKb5vxPGfFYB7sbJPT8uw3piiLGJs5rDDD` | `FtMjifF6LEMKFuiMAAS2qZvHLBvsbQ9CDSV7tZKdbQYU` | 0 lamports |

A wider grid scan (difficulties 1-9 x 14 common reward amounts, 126 PDA
derivations) found 18 existing specs, all with empty pools. Note: a complete
census was not possible because `getProgramAccounts` is disabled on the public
devnet RPC; every spec derivable from the standard difficulty/reward grid was
checked, including the exact d=3 / 0.02 SOL spec from the faucet's own
recommended command.

## 3. What the devnet run costs (verified figures)

`scripts/spike.mjs` needs on the creator wallet:

| item | amount |
|---|---|
| vault funding (demo funds) | 0.2 SOL |
| top-ups to AGENT + GATEKEEPER (0.05 each) | 0.1 SOL |
| rent: multisig account (200 B) | 0.001666 SOL |
| rent: 3 vault-transaction accounts (~1200 B each, paid by AGENT from its top-up) | ~0.0202 SOL |
| rent: 3 proposal accounts (167 B each, paid by AGENT) | ~0.0045 SOL |
| ~14 transaction fees @ 5000 lamports (incl. expected-fail executes) | ~0.00007 SOL |

Minimum creator balance to run as written: **~0.31 SOL**; **0.5 test SOL**
gives a comfortable margin. (The script's built-in `airdrop(creator, 2 SOL)`
is a legacy buffer from when the RPC faucet was open, not a requirement.)

Squads `multisigCreationFee` on the devnet program config: 0.

## 4. Remaining routes to test SOL

1. faucet.solana.com web form (manual; the page bans automated/agent use).
2. Anyone refilling a PoW-faucet source PDA (permissionless).
3. The cluster RPC faucet reopening.

A monitor checks these plus the creator wallet balance; on any change the
full spike runs against devnet and the transaction signatures get recorded here.

## 5. RESOLVED - public devnet run (2026-11-08 ~13:10 IST)

The creator wallet was funded (10 devnet SOL via faucet.solana.com by the
project owner) and the full three-scenario proof ran against
`api.devnet.solana.com`. All signatures below are real devnet transactions.

Canonical run (second run of the day, on a fresh demo window):

- Multisig (2-of-2: agent + gatekeeper): `BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC`
  ([explorer](https://explorer.solana.com/address/BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC?cluster=devnet))
- Vault: `93jfvLFdWn4CSPA9p7GeZWYubU4ZZ4H1m7Xa1UZtbwCe` (funded 0.2 SOL)
- Multisig create: `53BhKkN22wvbiVZY3GCjMFYPtqkNdRP22iN4seJvHAmJoKeQx9PYBGdVqDXSjwgZZHLZwVNm1nhLvxSdHrWxCQYx`

Scenario 1 - allowed payment (0.01 SOL vault -> Vendor A), policy ALLOW:
- vault tx create `r1STpqyTTi4vCL85XZa1dj7eD59MWMn49oSQWCc1bttSUZGfUB52cz4vtx1NvsqVg5rAyEXBVkuRUm52m4akUYN`
- proposal create `oKhfp5qpMddXcaJgyE5aBp5wDtVc4HFJUuuk1Njh1UYM8QDyUKszbRYaecn8GBhnLSgLjk3WBk9A7jRgqZmPxxe`
- agent approve `3Qj2AY3FpBrcuMetXJRMyKBJgAvwS93FYKWWTB5JtsE4Mg2G5tdL4ZFancWMy3YDC7iQ7kRbh482TirP8iazq8tC`
- gatekeeper approve `57yK3EseJhWjwLJUMwj1sFVoA3fuiMEX3iWrWpFmw4yEZ8xSdn1LgJafLUZ6hW9XrJnVujsyAWuEJ3M2NQVDkCUn`
- gatekeeper execute `3NxbjhoT1QDPGTfFDeTQBo2gMsNenkMa8LS6qWYLeLF5RToGV7fSWquvWGvse6MewnRmDMS7wMARzc7y3JVNXQmE`
  ([explorer](https://explorer.solana.com/tx/3NxbjhoT1QDPGTfFDeTQBo2gMsNenkMa8LS6qWYLeLF5RToGV7fSWquvWGvse6MewnRmDMS7wMARzc7y3JVNXQmE?cluster=devnet))
- Verified after: vendor 0.01 SOL, vault 0.19 SOL.

Scenario 2 - blocked attack (0.05 SOL vault -> blocked destination):
- Policy REJECT, sole reason: `destination 7GC8LGCn9vJ6jDQ1jQQ8ctyyRRcnSRWW2HvVDEsnKScM is explicitly blocked`.
- agent-alone execute FAILED on-chain (Squads 0x1774, no Execute permission).
- agent double-vote FAILED on-chain.
- gatekeeper execute on the unapproved proposal FAILED on-chain (0x1778, threshold unmet).
- Attacker balance verified 0 SOL.

Scenario 3 - non-custodial (gatekeeper alone):
- gatekeeper's own vault tx `37Vop9HWy5D9MGVBz5Fcw9Wi8p3YmE3kn1zfezTg3BZ2jiJY92vNUL6tRDoCzfKGLQQhPqEPxjX9BEZqn3jLuLyS`, proposal `59hVYuXTDw6s8PfuZa667TXNx3s2pbYr6sFUsFmKTHcdw3FnSpLQHZ5HhngnDARZhBUwE2Yf3wuoL61mcjCbk3zd`
- execute with 1 of 2 votes FAILED on-chain (0x1778). Vault unchanged.

Note on the first run the same hour (multisig
`8B581RzBzpB5R5PN8hexiq4XytkeARKBCYziCCxAkkx8`, execute
`6EV2YmwyshDuXrh1JWKzfPzTCioib6dmDc3CmHJHmayFDUa6VPPPU6JCPc2WHrwqdWRnvePYU5aw4JhjM22qMPD`):
its scenario-2 rejection additionally listed daily/total budget reasons. That
was stale state - the spend ledger (`data/audit.log`, gitignored) still carried
0.09 SOL of executed local-validator spends from the previous night, and the
policy evaluator counts all recorded spend toward the budgets regardless of
which cluster it happened on. Fixed by namespacing the spend ledger: every
entry is stamped with its (cluster, policy version) scope and budget/replay
accounting counts only entries from the active scope (`src/policy/engine.js`).
Executed history is preserved in full - scoping changes what counts toward a
budget, never what is recorded. Owner re-issue semantics are documented in
`scripts/issue-policy.mjs`: a plain re-issue extends expiry only; `--bump`
(new policy version) is the explicit re-authorization path and starts a fresh
budget namespace. The canonical run above was made after the fix; the attacker
transaction is blocked by its destination either way.
