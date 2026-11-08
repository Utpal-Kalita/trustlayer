// On-chain spend ledger for TrustLayer (prototype — local tests only, no hosted secrets).
// Design rationale and limits: docs/HOSTED-SIGNING-DESIGN.md
//
// Core idea: executed spend and pending reservations are derived from the
// chain itself, so an ephemeral host restart can never silently reset budget
// or replay state. Every proposal the engine creates carries a SPL Memo:
//   trustlayer:<policyId>:v<version>:<authId>
// Spend attribution counts executed vault outflows whose transaction carries
// a memo for the SAME policyId (any version: bumping the version is an owner
// re-issue and never resets spend; see design doc). Pending reservations
// count unexecuted Squads proposals whose vault transaction carries the memo.
//
// Fail-closed: if chain state cannot be derived, no execution is allowed.
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as multisig from '@sqds/multisig';

const { accounts } = multisig;

export const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export class LedgerUnavailable extends Error {
  constructor(msg) { super('ledger unavailable: ' + msg); this.name = 'LedgerUnavailable'; }
}

export function policyMemo(policyId, version, authId) {
  return `trustlayer:${policyId}:v${version}:${authId}`;
}

function memoMatches(data, policyId, version) {
  let s;
  try { s = Buffer.from(bs58.decode(data)).toString('utf8'); } catch { return false; }
  const prefix = `trustlayer:${policyId}:`;
  if (!s.startsWith(prefix)) return false;
  if (version == null) return true; // count all versions of this policyId
  return s.startsWith(`${prefix}v${version}:`);
}

// Parse authId out of a memo string, or null.
export function memoAuthId(data, policyId) {
  let s;
  try { s = Buffer.from(bs58.decode(data)).toString('utf8'); } catch { return null; }
  const m = s.match(new RegExp('^trustlayer:' + policyId + ':v(\\d+):(.+)$'));
  return m ? m[2] : null;
}

// Sum executed outgoing lamports from a vault AND collect consumed authIds,
// counting only transactions carrying this policy's memo. windowStart (ms
// epoch) scopes to the current validity window. Throws LedgerUnavailable on
// any RPC failure (fail-closed).
export async function deriveExecutedState(conn, vaultAddress, { policyId, windowStart = 0, pageLimit = 200 } = {}) {
  const vault = vaultAddress.toBase58 ? vaultAddress.toBase58() : String(vaultAddress);
  let sigs;
  try {
    sigs = await conn.getSignaturesForAddress(new PublicKey(vault), { limit: pageLimit });
  } catch (e) { throw new LedgerUnavailable('signature history: ' + e.message); }
  let total = 0;
  const authIds = new Set();
  for (const s of sigs) {
    if (s.err) continue;
    if (s.blockTime && s.blockTime * 1000 < windowStart) continue;
    let tx;
    try {
      tx = await conn.getTransaction(s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 });
    } catch (e) { throw new LedgerUnavailable('transaction fetch: ' + e.message); }
    if (!tx || !tx.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    const vIdx = keys.indexOf(vault);
    if (vIdx < 0) continue;
    let matched = null;
    for (const ix of (tx.transaction.message.instructions || [])) {
      const pid = typeof ix.programId === 'string' ? ix.programId : keys[ix.programIdIndex];
      if (pid !== MEMO_PROGRAM_V1 && pid !== MEMO_PROGRAM_V2) continue;
      const a = memoAuthId(ix.data, policyId);
      if (a) matched = a;
    }
    if (!matched) continue;
    authIds.add(matched);
    const delta = tx.meta.preBalances[vIdx] - tx.meta.postBalances[vIdx];
    if (delta > 0) total += delta;
  }
  return { lamports: total, authIds };
}

// Back-compat wrapper.
export async function deriveExecutedSpendLamports(conn, vaultAddress, opts = {}) {
  return (await deriveExecutedState(conn, vaultAddress, opts)).lamports;
}

// Sum lamports of SystemProgram transfers inside a decoded Squads vault
// transaction message, if the message carries this policy's memo.
// message: { accountKeys: (PublicKey|string)[], instructions: [{ programIdIndex, accountIndexes, data }] }
// Note: address lookup tables are not resolved — our own proposals never use ALTs.
export function sumPolicyTransfers(message, policyId) {
  const keys = message.accountKeys.map(k => (k.toBase58 ? k.toBase58() : String(k)));
  const ixs = message.instructions || [];
  const hasMemo = ixs.some(ix => {
    const pid = keys[ix.programIdIndex];
    return (pid === MEMO_PROGRAM_V1 || pid === MEMO_PROGRAM_V2) && memoMatches(ix.data, policyId, null);
  });
  if (!hasMemo) return 0;
  let total = 0;
  for (const ix of ixs) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM) continue;
    const data = Buffer.from(ix.data);
    if (data.length !== 12 || data.readUInt32LE(0) !== 2) continue; // Transfer
    total += Number(data.readBigUInt64LE(4));
  }
  return total;
}

// Sum pending (not Executed/Rejected/Cancelled) Squads proposal amounts whose
// vault transaction carries this policy's memo. These are reservations: they
// consume budget until they execute or are cancelled.
// chain adapter: { getMultisig(pda), getProposal(pda), getVaultTransaction(pda) }
export async function derivePendingReservationsLamports(chain, multisigAddress, { policyId, lookback = 64 } = {}) {
  let ms;
  try { ms = await chain.getMultisig(multisigAddress); }
  catch (e) { throw new LedgerUnavailable('multisig account: ' + e.message); }
  const current = Number(ms.transactionIndex);
  let total = 0;
  for (let idx = current; idx >= 1 && idx > current - lookback; idx--) {
    let prop;
    try { prop = await chain.getProposal(multisigAddress, idx); }
    catch { continue; } // index gap
    const kind = prop.status.__kind || prop.status;
    if (kind === 'Executed' || kind === 'Rejected' || kind === 'Cancelled') continue;
    let vtx;
    try { vtx = await chain.getVaultTransaction(multisigAddress, idx); }
    catch (e) { throw new LedgerUnavailable('vault transaction: ' + e.message); }
    total += sumPolicyTransfers(vtx.message, policyId);
  }
  return total;
}

// Real adapter over @solana/web3.js + @sqds/multisig.
export function squadsChainAdapter(conn) {
  return {
    getMultisig: (ms) => accounts.Multisig.fromAccountAddress(conn, new PublicKey(ms)),
    getProposal: (ms, idx) => accounts.Proposal.fromAccountAddress(conn, multisig.getProposalPda({ multisigPda: new PublicKey(ms), transactionIndex: BigInt(idx) })[0]),
    getVaultTransaction: (ms, idx) => accounts.VaultTransaction.fromAccountAddress(conn, multisig.getTransactionPda({ multisigPda: new PublicKey(ms), transactionIndex: BigInt(idx) })[0]),
  };
}

// Single-host atomic budget gate over on-chain-derived state.
// One instance = one proposer. Multi-host signing would additionally need an
// on-chain lock; out of scope for this prototype (see design doc).
export class SpendGate {
  // policy: { policyId, version, maxLamportsPerTx, maxTotalLamports }
  // loadChainState: async () => { executedLamports, reservedLamports } — MUST
  // throw (fail closed) when the chain cannot be read.
  constructor({ policy, loadChainState }) {
    this.policy = policy;
    this.loadChainState = loadChainState;
    this.inflight = new Map(); // authId -> lamports
    this.baseExecuted = null;
    this.baseReserved = null;
    this._q = Promise.resolve();
  }

  async bootstrap() {
    const s = await this.loadChainState(); // throws -> caller must not allow executions
    this.baseExecuted = s.executedLamports;
    this.baseReserved = s.reservedLamports;
    this.usedAuthIds = s.usedAuthIds || new Set();
  }

  get ready() { return this.baseExecuted !== null; }

  committedLamports() {
    if (!this.ready) throw new LedgerUnavailable('not bootstrapped');
    let t = this.baseExecuted + this.baseReserved;
    for (const v of this.inflight.values()) t += v;
    return t;
  }

  // Serialized check+reserve: concurrent callers cannot overspend.
  async tryReserve(authId, lamports) {
    const run = this._q.then(() => {
      if (!this.ready) throw new LedgerUnavailable('not bootstrapped');
      if (this.inflight.has(authId)) return { ok: false, reason: 'replay: authorization already in flight' };
      if (this.usedAuthIds && this.usedAuthIds.has(authId)) return { ok: false, reason: 'replay: authorization already executed on-chain' };
      if (lamports > this.policy.maxLamportsPerTx)
        return { ok: false, reason: `amount ${lamports} exceeds per-tx cap ${this.policy.maxLamportsPerTx}` };
      if (this.committedLamports() + lamports > this.policy.maxTotalLamports)
        return { ok: false, reason: 'total budget would be exceeded' };
      this.inflight.set(authId, lamports);
      return { ok: true };
    });
    this._q = run.catch(() => {});
    return run;
  }

  // executed=true: fold into executed base. executed=false: release.
  settle(authId, executed) {
    const v = this.inflight.get(authId);
    if (v == null) return;
    this.inflight.delete(authId);
    if (executed) { this.baseExecuted += v; if (this.usedAuthIds) this.usedAuthIds.add(authId); }
  }
}
