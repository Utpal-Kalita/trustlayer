// TrustLayer on-chain integration: proposal -> policy -> 2-of-2 approval -> execution.
// Works against any cluster in SOLANA_RPC (local validator or devnet when funded).
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';

const { transactions, accounts, types } = multisig;
const { Permissions, Permission } = types;

export function loadKeys(envFile = '.env') {
  // Secrets come from the .env file locally, or from real environment
  // variables on a hosted deploy (no .env file is ever committed or deployed).
  const env = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  for (const k of ['OWNER_SECRET', 'AGENT_SECRET', 'GATEKEEPER_SECRET', 'VENDOR_A_PUBKEY', 'ATTACKER_PUBKEY'])
    if (process.env[k]) env[k] = process.env[k];
  const kp = (n) => Keypair.fromSecretKey(bs58.decode(env[n + '_SECRET']));
  return { owner: kp('OWNER'), agent: kp('AGENT'), gatekeeper: kp('GATEKEEPER'), env };
}

export function loadState(file = 'data/state.json') {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export function saveState(state, file = 'data/state.json') {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

async function sendV(conn, tx, signers, label) {
  let sig;
  if ('version' in tx) {           // Squads builders return VersionedTransaction
    tx.sign(signers);
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const conf = await conn.confirmTransaction(sig, 'confirmed');
    if (conf?.value?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(conf.value.err)}`);
  } else {                          // legacy web3 Transaction
    sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  }
  console.log(`${label}: ${sig}`);
  return sig;
}

export async function ensureMultisig(conn, keys, state) {
  if (state.multisigPda) {
    try { await accounts.Multisig.fromAccountAddress(conn, new PublicKey(state.multisigPda)); return state; }
    catch { /* stale state, recreate */ }
  }
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
  const createTx = transactions.multisigCreateV2({
    blockhash: (await conn.getLatestBlockhash()).blockhash,
    treasury: programConfig.treasury, createKey: createKey.publicKey,
    creator: keys.owner.publicKey, multisigPda, configAuthority: keys.owner.publicKey, // owner can revoke or replace members (PRD Module 5)
    timeLock: 0, threshold: 2,
    members: [
      { key: keys.agent.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) },
      { key: keys.gatekeeper.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]) },
    ],
    rentCollector: null, memo: 'TrustLayer',
  });
  await sendV(conn, createTx, [keys.owner, createKey], 'multisig create');
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  state.multisigPda = multisigPda.toBase58();
  state.vaultPda = vaultPda.toBase58();
  saveState(state);
  return state;
}

// Demo funding helper: airdrops on clusters that allow it (local validator),
// otherwise tops up agent/gatekeeper from the owner wallet.
export async function ensureFunded(conn, keys) {
  const bal = await conn.getBalance(keys.owner.publicKey);
  if (bal < 0.1 * LAMPORTS_PER_SOL) {
    for (let i = 0; i < 3; i++) {
      try { await conn.confirmTransaction(await conn.requestAirdrop(keys.owner.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed'); break; }
      catch (e) { if (i === 2) throw new Error('owner wallet unfunded and airdrop failed - fund ' + keys.owner.publicKey.toBase58()); }
    }
  }
  for (const [label, k] of [['agent', keys.agent], ['gatekeeper', keys.gatekeeper]]) {
    const b = await conn.getBalance(k.publicKey);
    if (b < 0.02 * LAMPORTS_PER_SOL) {
      const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: keys.owner.publicKey, toPubkey: k.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
      await sendV(conn, t, [keys.owner], `fund ${label}`);
    }
  }
}

// Execute policy-approved SOL transfers through the Squads 2-of-2 vault.
//
// Called by the execution service only AFTER it has re-run inspection,
// simulation and the policy engine and reserved the spend. Steps:
//   1. agent creates the vault transaction + proposal and casts vote 1
//   2. the gatekeeper reads the vault transaction back FROM CHAIN, decodes it
//      and refuses to vote unless it is byte-for-byte the approved transfers
//   3. gatekeeper casts vote 2 (threshold met)
//   4. the real Squads execute instruction is simulated; only on success is it sent
// Returns { sig, multisig, vault, transactionIndex, steps[] }.
export async function executeSquadsTransfer(conn, keys, state, approved, { memo = 'trustlayer' } = {}) {
  const steps = [];
  const log = (step, sig) => { steps.push({ step, sig }); };
  await ensureFunded(conn, keys);
  state = await ensureMultisig(conn, keys, state);
  const multisigPda = new PublicKey(state.multisigPda);
  const vaultPda = new PublicKey(state.vaultPda);
  const ixs = approved.map(t => SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(t.to), lamports: t.lamports }));
  const bh = async () => (await conn.getLatestBlockhash()).blockhash;

  const ms = await accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const txIndex = BigInt(Number(ms.transactionIndex) + 1);
  const innerMsg = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: await bh(), instructions: ixs });
  log('vault transaction created by agent', await sendV(conn, transactions.vaultTransactionCreate({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, creator: keys.agent.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: innerMsg, memo }), [keys.agent], 'vault tx create'));
  log('proposal created by agent', await sendV(conn, transactions.proposalCreate({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, creator: keys.agent.publicKey }), [keys.agent], 'proposal create'));
  log('agent approval (1 of 2)', await sendV(conn, transactions.proposalApprove({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, member: keys.agent.publicKey }), [keys.agent], 'agent approve (1/2)'));

  // Gatekeeper verifies what is actually on chain before it votes.
  const [txPda] = multisig.getTransactionPda({ multisigPda, index: txIndex });
  const onchain = await accounts.VaultTransaction.fromAccountAddress(conn, txPda);
  const keysOn = onchain.message.accountKeys.map(k => k.toBase58());
  const decoded = onchain.message.instructions.map(ix => {
    const prog = keysOn[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    if (prog !== SystemProgram.programId.toBase58() || data.readUInt32LE(0) !== 2) return null;
    return { from: keysOn[ix.accountIndexes[0]], to: keysOn[ix.accountIndexes[1]], lamports: Number(data.readBigUInt64LE(4)) };
  });
  const same = decoded.length === approved.length && decoded.every((d, i) => d && d.from === vaultPda.toBase58() && d.to === approved[i].to && d.lamports === approved[i].lamports);
  if (!same) throw new Error('gatekeeper refused: on-chain vault transaction does not match the approved transfers');
  steps.push({ step: 'gatekeeper verified on-chain vault transaction matches the approved transfers', sig: null });

  log('gatekeeper approval (2 of 2)', await sendV(conn, transactions.proposalApprove({ blockhash: await bh(), feePayer: keys.gatekeeper.publicKey, multisigPda, transactionIndex: txIndex, member: keys.gatekeeper.publicKey, memo: 'trustlayer: all policy checks passed' }), [keys.gatekeeper], 'gatekeeper approve (2/2)'));

  // Simulate the real Squads execution path before sending it (PRD 12.3).
  const etx = await transactions.vaultTransactionExecute({ connection: conn, blockhash: await bh(), feePayer: keys.gatekeeper.publicKey, multisigPda, transactionIndex: txIndex, member: keys.gatekeeper.publicKey });
  const sim = await conn.simulateTransaction(etx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error('Squads execute simulation failed: ' + JSON.stringify(sim.value.err));
  steps.push({ step: `Squads execute simulated: success (${sim.value.unitsConsumed ?? '?'} CU)`, sig: null });
  const sig = await sendV(conn, etx, [keys.gatekeeper], 'execute');
  log('executed by Squads vault', sig);
  return { sig, multisig: state.multisigPda, vault: state.vaultPda, transactionIndex: Number(txIndex), steps };
}
