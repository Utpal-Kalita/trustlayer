// Gatekeeper (2-of-2) approval + execution for a Squads proposal created by the hosted agent.
// Runs from the owner side; GATEKEEPER_SECRET never leaves this environment.
// This script never creates proposals - it only votes on / executes an existing one.
//
// Before any approval vote, the script reads the vault transaction back FROM CHAIN and
// verifies it COMPLETELY:
//   - every instruction must be a decodable System Program SOL transfer or a Memo -
//     any other program or instruction shape REFUSES the approval (no silent skipping);
//   - every transfer must come FROM the Squads vault, and the vault must be the fee payer;
//   - with --expect, exactly one transfer must match the destination and lamports exactly;
//   - with --expect-memo, the on-chain memo must match exactly (binds the vote to the
//     exact authorized id, e.g. trustlayer:default-hackathon-policy:v1:<authId>).
//
// Usage:
//   node scripts/gatekeeper-execute.mjs <transactionIndex> [approve|reject|check] [--expect <destination> <lamports>] [--expect-memo <memo>]
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
const arg = (name) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : null; };
const expectTo = arg('--expect');
const expectLamports = expectTo ? BigInt(arg('--expect') && process.argv[process.argv.indexOf('--expect') + 2]) : null;
const expectMemo = arg('--expect-memo');

const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
const gatekeeper = Keypair.fromSecretKey(bs58.decode(env.GATEKEEPER_SECRET));
const multisigPda = new PublicKey('BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC');
const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const refuse = (why) => { console.error('REFUSING: ' + why); process.exit(1); };

// Read the vault transaction back from chain and classify EVERY instruction.
const [vaultTxPda] = multisig.getTransactionPda({ multisigPda, index: transactionIndex });
const vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(conn, vaultTxPda);
const keys = vaultTx.message.accountKeys;
if (!keys[0].equals(vaultPda)) refuse(`fee payer ${keys[0].toBase58()} is not the vault ${vaultPda.toBase58()}.`);

const transfers = [];
const memos = [];
vaultTx.message.instructions.forEach((ix, i) => {
  const programId = keys[ix.programIdIndex];
  const data = Buffer.from(ix.data);
  if (programId.equals(SystemProgram.programId)) {
    if (data.length === 12 && data.readUInt32LE(0) === 2) { // SystemProgram::Transfer
      transfers.push({ from: keys[ix.accountIndexes[0]], to: keys[ix.accountIndexes[1]], lamports: data.readBigUInt64LE(4) });
    } else {
      refuse(`instruction ${i} is an unrecognized System Program instruction (not a plain SOL transfer).`);
    }
  } else if (programId.equals(MEMO_PROGRAM)) {
    memos.push(data.toString('utf8'));
  } else {
    refuse(`instruction ${i} uses unrecognized program ${programId.toBase58()}.`);
  }
});
for (const t of transfers) if (!t.from.equals(vaultPda)) refuse(`transfer source ${t.from.toBase58()} is not the vault.`);

console.log('gatekeeper:', gatekeeper.publicKey.toBase58(), 'txIndex:', transactionIndex.toString());
console.log('on-chain vault transaction', vaultTxPda.toBase58(), '- fee payer: vault', vaultPda.toBase58());
for (const t of transfers) console.log(`  transfer: ${t.lamports} lamports (${Number(t.lamports) / 1e9} SOL)  ${t.from.toBase58()} -> ${t.to.toBase58()}`);
for (const m of memos) console.log(`  memo: ${m}`);
if (transfers.length === 0) refuse('no SOL transfers in this vault transaction.');

if (expectTo) {
  if (transfers.length !== 1) refuse(`expected exactly 1 transfer, found ${transfers.length}.`);
  const t = transfers[0];
  if (t.to.toBase58() !== expectTo || t.lamports !== expectLamports)
    refuse(`on-chain transfer (${t.lamports} lamports -> ${t.to.toBase58()}) does not match expected ${expectLamports} lamports -> ${expectTo}.`);
  console.log('on-chain transfer matches --expect.');
}
if (expectMemo) {
  if (!memos.includes(expectMemo)) refuse(`on-chain memo(s) [${memos.join(', ')}] do not include expected "${expectMemo}".`);
  console.log('on-chain memo matches --expect-memo.');
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
