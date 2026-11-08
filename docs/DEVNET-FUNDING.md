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
