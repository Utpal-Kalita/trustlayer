// Gatekeeper (2-of-2) approval + execution for a Squads proposal created by the hosted agent.
// Runs from the owner side; GATEKEEPER_SECRET never leaves this environment.
// Usage: node scripts/gatekeeper-execute.mjs <transactionIndex>
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}
const transactionIndex = BigInt(process.argv[2]);
const reject = process.argv[3] === 'reject';
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const gatekeeper = Keypair.fromSecretKey(bs58.decode(env.GATEKEEPER_SECRET));
const multisigPda = new PublicKey('BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC');
const bh = async () => (await conn.getLatestBlockhash('confirmed')).blockhash;
const send = async (tx, label) => {
  tx.sign([gatekeeper]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(label + ':', sig);
  return sig;
};
console.log('gatekeeper:', gatekeeper.publicKey.toBase58(), 'txIndex:', transactionIndex.toString());
if (reject) {
  await send(multisig.transactions.proposalReject({ blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'gatekeeper reject');
  console.log('REJECTED');
} else {
  await send(multisig.transactions.proposalApprove({ blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'gatekeeper approve (2/2)');
  await send(await multisig.transactions.vaultTransactionExecute({ connection: conn, blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda, transactionIndex, member: gatekeeper.publicKey }), 'execute');
  console.log('DONE');
}
