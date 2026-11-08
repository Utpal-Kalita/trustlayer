// Gatekeeper (2-of-2) approval + execution for a Squads proposal created by the hosted agent.
// Runs from the owner side; GATEKEEPER_SECRET never leaves this environment.
//
// Before any approval vote, the script reads the vault transaction back FROM CHAIN,
// decodes its inner SOL transfers, prints them for owner review, and (when --expect
// is given) refuses to approve unless every transfer matches the expected
// destination and lamport amount exactly.
//
// Usage:
//   node scripts/gatekeeper-execute.mjs <transactionIndex> [approve|reject|check] [--expect <destination> <lamports>]
//     approve  (default) verify, print, approve (2/2), execute
//     reject   reject the proposal on chain
//     check    verify and print only - no vote, no execution
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}
const transactionIndex = BigInt(process.argv[2]);
const action = ['approve', 'reject', 'check'].includes(process.argv[3]) ? process.argv[3] : 'approve';
const ei = process.argv.indexOf('--expect');
const expect = ei !== -1 ? { to: process.argv[ei + 1], lamports: BigInt(process.argv[ei + 2]) } : null;

const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
const gatekeeper = Keypair.fromSecretKey(bs58.decode(env.GATEKEEPER_SECRET));
const multisigPda = new PublicKey('BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC');

// Read the vault transaction back from chain and decode inner SOL transfers.
const [vaultTxPda] = multisig.getTransactionPda({ multisigPda, index: transactionIndex });
const vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(conn, vaultTxPda);
const keys = vaultTx.message.accountKeys;
const transfers = [];
for (const ix of vaultTx.message.instructions) {
  const programId = keys[ix.programIdIndex];
  if (!programId.equals(SystemProgram.programId)) continue;
  const data = Buffer.from(ix.data);
  if (data.length === 12 && data.readUInt32LE(0) === 2) { // SystemProgram::Transfer
    transfers.push({
      from: keys[ix.accountIndexes[0]].toBase58(),
      to: keys[ix.accountIndexes[1]].toBase58(),
      lamports: data.readBigUInt64LE(4),
    });
  }
}
console.log('gatekeeper:', gatekeeper.publicKey.toBase58(), 'txIndex:', transactionIndex.toString());
console.log('on-chain vault transaction', vaultTxPda.toBase58(), 'contains', transfers.length, 'SOL transfer(s):');
for (const t of transfers) console.log(`  ${t.lamports} lamports (${Number(t.lamports) / 1e9} SOL)  ${t.from} -> ${t.to}`);

if (action !== 'reject') {
  if (transfers.length === 0) {
    console.error('REFUSING: no decodable SOL transfers in this vault transaction.');
    process.exit(1);
  }
  if (expect) {
    const ok = transfers.length === 1 && transfers[0].to === expect.to && transfers[0].lamports === expect.lamports;
    if (!ok) {
      console.error(`REFUSING: on-chain contents do not match expected ${expect.lamports} lamports -> ${expect.to}.`);
      process.exit(1);
    }
    console.log('on-chain contents match --expect; proceeding.');
  } else {
    console.log('no --expect given; review the transfers above before approving.');
  }
}
if (action === 'check') { console.log('CHECK ONLY - no vote cast.'); process.exit(0); }

const bh = async () => (await conn.getLatestBlockhash('confirmed')).blockhash;
const send = async (tx, label) => {
  tx.sign([gatekeeper]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(label + ':', sig);
  return sig;
};
if (action === 'reject') {
  await send(multisig.transactions.proposalReject({ blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'gatekeeper reject');
  console.log('REJECTED');
} else {
  await send(multisig.transactions.proposalApprove({ blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'gatekeeper approve (2/2)');
  await send(await multisig.transactions.vaultTransactionExecute({ connection: conn, blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'execute');
  console.log('DONE');
}
