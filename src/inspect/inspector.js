// Transaction inspection (PRD Module 3, section 12.3).
//
// An agent proposes either
//   - a serialized Solana transaction (`transaction`, base64, legacy or v0), or
//   - a structured SOL payment (`recipient`, `amountSol`), which TrustLayer
//     turns into the exact System Program instruction it would execute.
// Either way the policy engine only ever sees what the instructions DO, decoded
// from their bytes: every instruction, not just the first. Anything TrustLayer
// cannot decode with certainty is reported as unsupported and rejected.
import { PublicKey, SystemProgram, Transaction, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL } from '@solana/web3.js';

export const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Instructions that move no value and change no authority.
const BENIGN = new Map([
  ['ComputeBudget111111111111111111111111111111', 'compute_budget'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'memo'],
  ['Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'memo'],
]);

export class InspectionError extends Error {}

export function isAddress(s) {
  try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()) || new PublicKey(s).toBase58() === s; } catch { return false; }
}

export function solToLamports(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * LAMPORTS_PER_SOL);
}

// Decode one instruction into its semantic content.
export function decodeInstruction({ programId, keys, data }) {
  const buf = Buffer.from(data);
  if (programId === SYSTEM_PROGRAM) {
    if (buf.length >= 12 && buf.readUInt32LE(0) === 2) {
      return { programId, action: 'sol_transfer', from: keys[0], to: keys[1], lamports: Number(buf.readBigUInt64LE(4)) };
    }
    return { programId, action: 'system_other', unsupported: true, detail: `System Program instruction #${buf.length >= 4 ? buf.readUInt32LE(0) : '?'}` };
  }
  if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
    const tag = buf[0];
    if (tag === 3 || tag === 12) return { programId, action: 'spl_transfer', from: keys[0], to: keys[tag === 3 ? 1 : 2], unsupported: true, detail: 'SPL token transfer' };
    return { programId, action: 'token_other', unsupported: true, detail: `Token Program instruction #${tag}` };
  }
  if (BENIGN.has(programId)) return { programId, action: BENIGN.get(programId), benign: true };
  return { programId, action: 'unknown_program', unsupported: true, detail: `unrecognised program ${programId}` };
}

// Turn a proposal into a list of decoded instructions plus the summary the
// policy engine needs: sender, recipients, total lamports, programs, action.
export function inspectProposal(proposal, { senderWallet }) {
  let instructions;
  let feePayer = null;
  let source;

  if (proposal.transaction) {
    source = 'serialized';
    let raw;
    try { raw = Buffer.from(String(proposal.transaction), 'base64'); } catch { throw new InspectionError('transaction is not valid base64'); }
    let msgKeys, ixs;
    try {
      const vtx = VersionedTransaction.deserialize(raw);
      const m = vtx.message;
      if (m.addressTableLookups?.length) throw new InspectionError('transactions using address lookup tables are not supported');
      msgKeys = m.staticAccountKeys.map(k => k.toBase58());
      ixs = m.compiledInstructions.map(ix => ({ programId: msgKeys[ix.programIdIndex], keys: ix.accountKeyIndexes.map(i => msgKeys[i]), data: ix.data }));
    } catch (e) {
      if (e instanceof InspectionError) throw e;
      try {
        const tx = Transaction.from(raw);
        msgKeys = [tx.feePayer?.toBase58()];
        ixs = tx.instructions.map(ix => ({ programId: ix.programId.toBase58(), keys: ix.keys.map(k => k.pubkey.toBase58()), data: ix.data }));
        feePayer = tx.feePayer?.toBase58() || null;
      } catch { throw new InspectionError('could not deserialize transaction'); }
    }
    feePayer = feePayer || msgKeys[0];
    instructions = ixs.map(decodeInstruction);
  } else {
    source = 'structured';
    const action = String(proposal.action || 'sol_transfer');
    const recipient = String(proposal.recipient || proposal.destination || '');
    const lamports = solToLamports(proposal.amountSol);
    if (!isAddress(recipient)) throw new InspectionError(`recipient "${recipient}" is not a valid Solana address`);
    if (!(lamports > 0)) throw new InspectionError(`amount ${proposal.amountSol} is not a positive SOL amount`);
    if (!isAddress(senderWallet)) throw new InspectionError('agent has no valid wallet or vault address');
    if (action === 'sol_transfer') {
      const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(senderWallet), toPubkey: new PublicKey(recipient), lamports });
      instructions = [decodeInstruction({ programId: ix.programId.toBase58(), keys: ix.keys.map(k => k.pubkey.toBase58()), data: ix.data })];
    } else {
      // The agent asked for something other than a SOL payment. Record what
      // it asked for so the action check can reject it with a clear reason.
      instructions = [{ programId: null, action, from: senderWallet, to: recipient, lamports, unsupported: true, detail: `requested action "${action}"` }];
    }
    feePayer = senderWallet;
  }

  if (!instructions.length) throw new InspectionError('transaction has no instructions');
  const value = instructions.filter(i => !i.benign);
  const transfers = value.filter(i => i.action === 'sol_transfer');
  return {
    source,
    feePayer,
    instructions,
    sender: transfers[0]?.from ?? value[0]?.from ?? feePayer,
    senders: [...new Set(value.map(i => i.from).filter(Boolean))],
    recipients: [...new Set(value.map(i => i.to).filter(Boolean))],
    lamports: transfers.reduce((s, i) => s + i.lamports, 0) + value.filter(i => i.action !== 'sol_transfer').reduce((s, i) => s + (i.lamports || 0), 0),
    actions: [...new Set(value.map(i => i.action))],
    programs: [...new Set(instructions.map(i => i.programId).filter(Boolean))],
    unsupported: instructions.filter(i => i.unsupported).map(i => i.detail),
  };
}

// Rebuild the value-moving instructions as a message paid by the vault, for
// simulation and for the Squads vault transaction. Only called on proposals
// that passed inspection (pure SOL transfers from the agent's vault).
export function buildTransferInstructions(inspection) {
  return inspection.instructions
    .filter(i => i.action === 'sol_transfer')
    .map(i => SystemProgram.transfer({ fromPubkey: new PublicKey(i.from), toPubkey: new PublicKey(i.to), lamports: i.lamports }));
}

export function buildMessage(payer, instructions, blockhash) {
  return new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions });
}
