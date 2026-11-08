// TrustLayer on-chain integration, AGENT SIDE ONLY.
//
// Key separation (docs/INTEGRATION.md, requirement 1): this module, and any
// server that imports it, loads only AGENT_SECRET. It can create a Squads vault
// transaction + proposal and cast approval 1 of 2. It cannot move funds.
// The gatekeeper's vote 2 of 2 and the execution happen owner-side, in a
// separate process: node scripts/gatekeeper-execute.mjs <txIndex> ...
// The OWNER and GATEKEEPER keys are never read here.
//
// It reuses the verified devnet multisig (data/state.json). It never creates a
// multisig and never requests airdrops.
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';

const { transactions, accounts } = multisig;
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const VERIFIED_MULTISIG = 'BLQCpxEZphLk4BexY7fpZmaP9oZTsmMxc7ZNDRvtitEC';

function readEnvFile(envFile = '.env') {
  const env = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

// The only secret this process may hold.
export function loadAgentKey(envFile = '.env') {
  const secret = process.env.AGENT_SECRET || readEnvFile(envFile).AGENT_SECRET;
  if (!secret) return null;
  return Keypair.fromSecretKey(bs58.decode(secret));
}

// Public addresses only (demo vendor / attacker for scripts and the console).
export function loadPublicAddresses(envFile = '.env') {
  const env = readEnvFile(envFile);
  return { vendorA: process.env.VENDOR_A_PUBKEY || env.VENDOR_A_PUBKEY || null, attacker: process.env.ATTACKER_PUBKEY || env.ATTACKER_PUBKEY || null };
}

export function loadState(file = 'data/state.json') {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

async function send(conn, tx, signer) {
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

// Agent side of the Squads flow for policy-approved SOL transfers:
//   vault transaction (transfers + memo) -> proposal -> agent approval (1 of 2).
// Returns { transactionIndex, sigs, memo, multisig, vault }. Funds have NOT moved.
export async function proposeSquadsTransfer(conn, agent, state, transfers, memo) {
  if (!state.multisigPda || !state.vaultPda) throw new Error('no multisig configured in data/state.json');
  const multisigPda = new PublicKey(state.multisigPda);
  const vaultPda = new PublicKey(state.vaultPda);
  const [derivedVault] = multisig.getVaultPda({ multisigPda, index: 0 });
  if (!derivedVault.equals(vaultPda)) throw new Error('data/state.json vault does not belong to its multisig');

  const ms = await accounts.Multisig.fromAccountAddress(conn, multisigPda);
  if (!ms.members.some(m => m.key.equals(agent.publicKey))) throw new Error('AGENT_SECRET is not a member of this multisig');
  const transactionIndex = BigInt(Number(ms.transactionIndex) + 1);
  const bh = async () => (await conn.getLatestBlockhash('confirmed')).blockhash;

  const instructions = [
    ...transfers.map(t => SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(t.to), lamports: t.lamports })),
    { programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo, 'utf8') },
  ];
  const sigs = {};
  sigs.create = await send(conn, transactions.vaultTransactionCreate({
    blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, creator: agent.publicKey,
    vaultIndex: 0, ephemeralSigners: 0, memo: memo.slice(0, 60),
    transactionMessage: new TransactionMessage({ payerKey: vaultPda, recentBlockhash: await bh(), instructions }),
  }), agent);
  sigs.proposal = await send(conn, transactions.proposalCreate({ blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, creator: agent.publicKey }), agent);
  sigs.agentApprove = await send(conn, transactions.proposalApprove({ blockhash: await bh(), feePayer: agent.publicKey, multisigPda, transactionIndex, member: agent.publicKey }), agent);
  return { transactionIndex: Number(transactionIndex), sigs, memo, multisig: state.multisigPda, vault: state.vaultPda };
}

// Read a proposal's on-chain status: 'active' | 'approved' | 'executed' | 'rejected' | 'cancelled' | 'missing'.
// For executed proposals, also finds the execution signature.
export async function proposalStatus(conn, state, transactionIndex) {
  const multisigPda = new PublicKey(state.multisigPda);
  const index = BigInt(transactionIndex);
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: index });
  let p;
  try { p = await accounts.Proposal.fromAccountAddress(conn, proposalPda); } catch { return { status: 'missing' }; }
  const kind = p.status.__kind.toLowerCase();
  const out = { status: kind, approvals: p.approved.length };
  if (kind === 'executed') {
    const [txPda] = multisig.getTransactionPda({ multisigPda, index });
    const sigs = await conn.getSignaturesForAddress(txPda, { limit: 5 });
    out.signature = sigs.find(s => !s.err)?.signature ?? null;
  }
  return out;
}

export function connectionFor(url) { return new Connection(url, 'confirmed'); }
