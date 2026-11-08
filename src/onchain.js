// TrustLayer on-chain integration: proposal -> policy -> 2-of-2 approval -> execution.
// Works against any cluster in SOLANA_RPC (local validator or devnet when funded).
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';
import { loadPolicy, evaluate } from './policy/engine.js';

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
    creator: keys.owner.publicKey, multisigPda, configAuthority: null, timeLock: 0, threshold: 2,
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

// The full TrustLayer flow for one requested payment. Returns {decision, sig?}.
// Decode a SystemProgram transfer instruction back to its semantic content.
// The policy is evaluated against what the transaction ACTUALLY does, never
// against caller-supplied descriptions.
function decodeTransferInstruction(ix) {
  const programId = ix.programId.toBase58();
  if (programId !== SystemProgram.programId.toBase58()) return { programId, action: 'unknown', destination: null, amountSol: null };
  const view = Buffer.from(ix.data);
  const tag = view.readUInt32LE(0);
  if (tag !== 2) return { programId, action: 'system-other', destination: null, amountSol: null }; // 2 = Transfer
  const lamports = Number(view.readBigUInt64LE(4));
  return { programId, action: 'transfer', destination: ix.keys[1].pubkey.toBase58(), amountSol: lamports / LAMPORTS_PER_SOL };
}

export async function runProposal(conn, keys, state, audit, { destination, amountSol, nonce }) {
  const { policy } = loadPolicy();

  // Build the exact instruction first, then evaluate its DECODED content.
  const vaultProbe = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: new PublicKey(destination), lamports: Math.round(amountSol * LAMPORTS_PER_SOL) });
  const decoded = decodeTransferInstruction(vaultProbe);
  const decision = evaluate(policy, { ...decoded, nonce }, audit);
  const rid = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!decision.allow) {
    audit.record({ kind: 'propose', id: rid, nonce: decision.authId ?? nonce, destination: decoded.destination, amountSol: decoded.amountSol, decision: 'rejected', reasons: decision.reasons });
    return { decision, sig: null };
  }
  // Reserve budget synchronously (no awaits since evaluation) before any chain work.
  audit.record({ kind: 'propose', id: rid, nonce: decision.authId ?? nonce, destination: decoded.destination, amountSol: decoded.amountSol, decision: 'allowed', reasons: [], reserved: true });

  // Any failure after the budget reservation must release it, or retries
  // would be blocked by a permanently held reservation.
  try {
  await ensureFunded(conn, keys);
  state = await ensureMultisig(conn, keys, state);
  const multisigPda = new PublicKey(state.multisigPda);
  const vaultPda = new PublicKey(state.vaultPda);

  // keep the vault funded enough for the transfer (demo: owner tops up to 0.2)
  const vbal = await conn.getBalance(vaultPda);
  if (vbal < amountSol * LAMPORTS_PER_SOL) {
    const topup = new Transaction().add(SystemProgram.transfer({ fromPubkey: keys.owner.publicKey, toPubkey: vaultPda, lamports: 0.2 * LAMPORTS_PER_SOL }));
    await sendV(conn, topup, [keys.owner], 'vault topup');
  }

  const ms = await accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const txIndex = BigInt(Number(ms.transactionIndex) + 1);
  const innerMsg = new TransactionMessage({
    payerKey: vaultPda, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(destination), lamports: Math.round(amountSol * LAMPORTS_PER_SOL) })],
  });
  const bh = async () => (await conn.getLatestBlockhash()).blockhash;
  const vtx = transactions.vaultTransactionCreate({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, creator: keys.agent.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: innerMsg, memo: 'trustlayer payment' });
  await sendV(conn, vtx, [keys.agent], 'vault tx create');
  const ptx = transactions.proposalCreate({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, creator: keys.agent.publicKey });
  await sendV(conn, ptx, [keys.agent], 'proposal create');
  const a1 = transactions.proposalApprove({ blockhash: await bh(), feePayer: keys.agent.publicKey, multisigPda, transactionIndex: txIndex, member: keys.agent.publicKey });
  await sendV(conn, a1, [keys.agent], 'agent approve (1/2)');
  const a2 = transactions.proposalApprove({ blockhash: await bh(), feePayer: keys.gatekeeper.publicKey, multisigPda, transactionIndex: txIndex, member: keys.gatekeeper.publicKey, memo: 'policy: all checks passed' });
  await sendV(conn, a2, [keys.gatekeeper], 'gatekeeper approve (2/2)');
  const etx = await transactions.vaultTransactionExecute({ connection: conn, blockhash: await bh(), feePayer: keys.gatekeeper.publicKey, multisigPda, transactionIndex: txIndex, member: keys.gatekeeper.publicKey });
  const sig = await sendV(conn, etx, [keys.gatekeeper], 'execute');
  audit.record({ kind: 'execute', id: rid, nonce: decision.authId ?? nonce, destination: decoded.destination, amountSol: decoded.amountSol, decision: 'allowed', reasons: [], executed: true, sig });
  return { decision, sig, multisig: state.multisigPda, txIndex: Number(txIndex) };
  } catch (err) {
    audit.record({ kind: 'execute', id: rid, nonce: decision.authId ?? nonce, released: true, note: String(err).slice(0, 200) });
    throw err;
  }
}
