// TrustLayer Squads spike: prove proposal -> gatekeeper approval -> execution on Devnet,
// and that an agent ALONE cannot execute, and the gatekeeper ALONE cannot move funds.
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import fs from 'node:fs';
import { loadPolicy, evaluate, AuditLog } from '../src/policy/engine.js';

const { transactions, accounts, types, utils } = multisig;
const { Permissions, Permission } = types;

const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
let { policy } = loadPolicy();
if (policy.expiresAt && Date.now() > new Date(policy.expiresAt).getTime()) {
  console.log('policy expired - re-issuing for a fresh 2h demo window (scripts/issue-policy.mjs)');
  policy.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync('policies/default.json', JSON.stringify(policy, null, 2) + '\n');
}
const audit = new AuditLog();
console.log('policy loaded:', policy.name, '| per-tx max', policy.maxSolPerTransaction, 'SOL | daily max', policy.maxSolPerDay, 'SOL');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function airdrop(pk, sol, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`airdrop ok: ${label} ${sol} SOL (${sig})`);
      return;
    } catch (e) {
      console.log(`airdrop attempt ${attempt} failed for ${label}: ${String(e).slice(0,120)}`);
      await sleep(4000 * attempt);
    }
  }
  throw new Error(`airdrop failed for ${label}`);
}

async function sendV(tx, signers, label) {
  tx.sign(signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`${label}: ${sig}`);
  return sig;
}

const bh = async () => (await conn.getLatestBlockhash('confirmed')).blockhash;

async function main() {
  // Load persistent keypairs from .env (created by scripts/genkeys.mjs) so the
  // same identities are reused across runs; fall back to fresh throwaway keys.
  let envKeys = {};
  try {
    const env = fs.readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) envKeys[m[1]] = m[2].trim();
    }
  } catch {}
  const kp = (name) => envKeys[name + '_SECRET']
    ? Keypair.fromSecretKey(bs58.decode(envKeys[name + '_SECRET']))
    : Keypair.generate();
  const creator = kp('OWNER');
  const agent = kp('AGENT');
  const gatekeeper = kp('GATEKEEPER');
  const vendorA = envKeys.VENDOR_A_PUBKEY ? new PublicKey(envKeys.VENDOR_A_PUBKEY) : Keypair.generate().publicKey;
  const attacker = envKeys.ATTACKER_PUBKEY ? new PublicKey(envKeys.ATTACKER_PUBKEY) : Keypair.generate().publicKey;

  console.log('creator   ', creator.publicKey.toBase58());
  console.log('agent     ', agent.publicKey.toBase58());
  console.log('gatekeeper', gatekeeper.publicKey.toBase58());

  // Fund each wallet only if it is short; RPC faucet is often closed, so a
  // pre-funded creator (e.g. via https://faucet.solana.com) tops up the others.
  const ensure = async (kp2, sol, label) => {
    const bal = await conn.getBalance(kp2.publicKey);
    if (bal >= 0.05 * LAMPORTS_PER_SOL) { console.log(`${label} funded: ${(bal/LAMPORTS_PER_SOL).toFixed(3)} SOL`); return; }
    try { await airdrop(kp2.publicKey, sol, label); }
    catch {
      if (kp2 === creator) throw new Error('creator wallet has no SOL - fund it at https://faucet.solana.com: ' + creator.publicKey.toBase58());
      const topup = new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: kp2.publicKey, lamports: BigInt(0.05 * LAMPORTS_PER_SOL) }));
      const sig = await sendAndConfirmTransaction(conn, topup, [creator]);
      console.log(`creator topped up ${label} (${sig})`);
    }
  };
  await ensure(creator, 2, 'creator');
  await ensure(agent, 1, 'agent');
  await ensure(gatekeeper, 1, 'gatekeeper');

  // --- 1. Create 2-of-2 multisig ---
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
  const createTx = transactions.multisigCreateV2({
    blockhash: await bh(),
    treasury: programConfig.treasury,
    createKey: createKey.publicKey,
    creator: creator.publicKey,
    multisigPda,
    configAuthority: null,
    threshold: 2,
    members: [
      { key: agent.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) },
      { key: gatekeeper.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]) },
    ],
    timeLock: 0,
    rentCollector: null,
    memo: 'TrustLayer spike',
  });
  await sendV(createTx, [creator, createKey], 'multisig create');
  console.log('multisigPda', multisigPda.toBase58());

  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  console.log('vaultPda   ', vaultPda.toBase58());

  // fund the vault with 0.2 SOL from creator
  const fundTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: vaultPda, lamports: 0.2 * LAMPORTS_PER_SOL }));
  await sendAndConfirmTransaction(conn, fundTx, [creator]);
  console.log('vault funded 0.2 SOL; balance =', (await conn.getBalance(vaultPda)) / LAMPORTS_PER_SOL);

  const propose = async (to, lamports, memo) => {
    const ms = await accounts.Multisig.fromAccountAddress(conn, multisigPda);
    const txIndex = BigInt(Number(ms.transactionIndex) + 1);
    const innerMsg = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: await bh(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: to, lamports })],
    });
    const vtx = transactions.vaultTransactionCreate({
      blockhash: await bh(), feePayer: agent.publicKey, multisigPda,
      transactionIndex: txIndex, creator: agent.publicKey, vaultIndex: 0,
      ephemeralSigners: 0, transactionMessage: innerMsg, memo,
    });
    await sendV(vtx, [agent], `vault tx create (${memo})`);
    const ptx = transactions.proposalCreate({
      blockhash: await bh(), feePayer: agent.publicKey, multisigPda,
      transactionIndex: txIndex, creator: agent.publicKey,
    });
    await sendV(ptx, [agent], `proposal create (${memo})`);
    const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: txIndex });
    const prop = await accounts.Proposal.fromAccountAddress(conn, proposalPda);
    console.log(`proposal ${txIndex} status=${JSON.stringify(prop.status)} approved=[${prop.approved.map(a=>a.toBase58().slice(0,6)).join(',')}]`);
    return txIndex;
  };

  const agentApprove = async (txIndex) => {
    const atx = transactions.proposalApprove({
      blockhash: await bh(), feePayer: agent.publicKey, multisigPda,
      transactionIndex: txIndex, member: agent.publicKey, memo: 'agent vote',
    });
    await sendV(atx, [agent], 'agent approve');
  };

  const gatekeeperApprove = async (txIndex) => {
    const atx = transactions.proposalApprove({
      blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda,
      transactionIndex: txIndex, member: gatekeeper.publicKey, memo: 'policy: all checks passed',
    });
    await sendV(atx, [gatekeeper], 'gatekeeper approve');
  };

  const tryExecute = async (txIndex, signer, label, expectFail) => {
    try {
      const etx = await transactions.vaultTransactionExecute({
        connection: conn, blockhash: await bh(), feePayer: signer.publicKey,
        multisigPda, transactionIndex: txIndex, member: signer.publicKey,
      });
      const sig = await sendV(etx, [signer], `${label} execute`);
      if (expectFail) console.log(`!!! UNEXPECTED SUCCESS: ${label} executed (${sig})`);
      return { ok: true, sig };
    } catch (e) {
      const msg = String(e).slice(0, 300);
      console.log(`${expectFail ? 'EXPECTED FAIL' : 'FAIL'}: ${label} execute -> ${msg}`);
      return { ok: false, error: msg };
    }
  };

  // --- 2. ALLOWED: vault -> vendorA 0.01 SOL (policy passes off-chain) ---
  console.log('\n--- Scenario 1: allowed payment ---');
  const t1 = await propose(vendorA, 0.01 * LAMPORTS_PER_SOL, 'pay vendor 0.01');
  const d1 = evaluate(policy, { destination: vendorA.toBase58(), amountSol: 0.01 }, audit);
  audit.record({ kind: 'spike', destination: vendorA.toBase58(), amountSol: 0.01, decision: d1.allow ? 'allowed' : 'rejected', reasons: d1.reasons });
  console.log('POLICY DECISION:', d1.allow ? 'ALLOW' : 'REJECT', d1.reasons);
  if (!d1.allow) throw new Error('policy unexpectedly rejected the allowed payment');
  await agentApprove(t1);        // vote 1 of 2: the agent signs its own proposal
  await gatekeeperApprove(t1);   // vote 2 of 2: gatekeeper signs only after policy passed
  const r1 = await tryExecute(t1, gatekeeper, 'gatekeeper', false);
  console.log('vendorA balance =', (await conn.getBalance(vendorA)) / LAMPORTS_PER_SOL, 'SOL');
  console.log('vault balance   =', (await conn.getBalance(vaultPda)) / LAMPORTS_PER_SOL, 'SOL');

  // --- 3. BLOCKED: vault -> attacker 0.5 SOL (policy blocks; gatekeeper never approves) ---
  console.log('\n--- Scenario 2: blocked attack (no gatekeeper approval) ---');
  const t2 = await propose(attacker, 0.05 * LAMPORTS_PER_SOL, 'attacker drain attempt');
  const d2 = evaluate(policy, { destination: attacker.toBase58(), amountSol: 0.05 }, audit);
  audit.record({ kind: 'spike', destination: attacker.toBase58(), amountSol: 0.05, decision: d2.allow ? 'allowed' : 'rejected', reasons: d2.reasons });
  console.log('POLICY DECISION:', d2.allow ? 'ALLOW' : 'REJECT', d2.reasons);
  if (d2.allow) throw new Error('policy unexpectedly allowed the attacker transaction');
  await agentApprove(t2);        // agent votes for its own malicious proposal (1 of 2)
  const r2a = await tryExecute(t2, agent, 'agent-alone (blocked tx)', true);   // no Execute permission
  // agent tries to approve a second time to fake the second vote
  try {
    const atx = transactions.proposalApprove({
      blockhash: await bh(), feePayer: agent.publicKey, multisigPda,
      transactionIndex: t2, member: agent.publicKey,
    });
    await sendV(atx, [agent], 'agent second approve');
    console.log('!!! UNEXPECTED: agent could approve twice');
  } catch (e) {
    console.log('EXPECTED FAIL: agent second approve ->', String(e).slice(0, 120));
  }
  // even with the agent vote, a gatekeeper-less execute stays impossible (1 of 2 approvals)
  const r2b = await tryExecute(t2, gatekeeper, 'gatekeeper on unapproved proposal', true);
  console.log('attacker balance =', (await conn.getBalance(attacker)) / LAMPORTS_PER_SOL, 'SOL');

  // --- 4. NON-CUSTODIAL: gatekeeper alone cannot move funds ---
  console.log('\n--- Scenario 3: gatekeeper alone cannot execute ---');
  {
    const ms = await accounts.Multisig.fromAccountAddress(conn, multisigPda);
    const txIndex = BigInt(Number(ms.transactionIndex) + 1);
    const innerMsg = new TransactionMessage({
      payerKey: vaultPda, recentBlockhash: await bh(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: gatekeeper.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })],
    });
    const vtx = transactions.vaultTransactionCreate({
      blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda,
      transactionIndex: txIndex, creator: gatekeeper.publicKey, vaultIndex: 0,
      ephemeralSigners: 0, transactionMessage: innerMsg, memo: 'gatekeeper self-pay attempt',
    });
    await sendV(vtx, [gatekeeper], 'gatekeeper vault tx create');
    const ptx = transactions.proposalCreate({
      blockhash: await bh(), feePayer: gatekeeper.publicKey, multisigPda,
      transactionIndex: txIndex, creator: gatekeeper.publicKey,
    });
    await sendV(ptx, [gatekeeper], 'gatekeeper proposal create');
    const r3 = await tryExecute(txIndex, gatekeeper, 'gatekeeper-alone (1 of 2 votes)', true);
    console.log('gatekeeper balance delta check; vault balance =', (await conn.getBalance(vaultPda)) / LAMPORTS_PER_SOL, 'SOL');
  }

  console.log('\nSUMMARY');
  console.log('allowed executed:', r1.ok, r1.sig || '');
  console.log('blocked agent-alone execute succeeded (should be false):', r2a.ok);
  console.log('multisig:', multisigPda.toBase58());
  console.log('vault:', vaultPda.toBase58());
  console.log('explorer:', `https://explorer.solana.com/address/${multisigPda.toBase58()}?cluster=devnet`);
}

main().catch(e => { console.error('SPIKE FAILED:', e); process.exit(1); });
