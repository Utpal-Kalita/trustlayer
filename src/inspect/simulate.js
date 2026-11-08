// Transaction simulation against live Solana state (PRD Module 3).
//
// The vault-signed transfer is simulated with signature verification off and
// a fresh blockhash, exactly as the Squads vault would execute it (the vault
// PDA is the payer and the source of funds). Simulation answers "would this
// succeed on chain?" - it never answers "is this allowed?". The policy engine
// decides that from the decoded instructions (PRD 12.3).
//
// TRUSTLAYER_SIMULATION:
//   required (default) - no successful simulation, no approval (fail closed)
//   off                - skip simulation (offline tests only; shown on every decision)
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { buildTransferInstructions, buildMessage } from './inspector.js';

export const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
export const SIMULATION_MODE = (process.env.TRUSTLAYER_SIMULATION || 'required').toLowerCase();

let conn;
export function connection() { return conn ||= new Connection(RPC_URL, 'confirmed'); }

export async function simulateInspection(inspection, { mode = SIMULATION_MODE, rpc = connection() } = {}) {
  if (mode === 'off') return { ran: false, ok: true, mode, note: 'simulation disabled (TRUSTLAYER_SIMULATION=off)' };
  try {
    const ixs = buildTransferInstructions(inspection);
    const { blockhash } = await rpc.getLatestBlockhash();
    const tx = new VersionedTransaction(buildMessage(inspection.sender, ixs, blockhash).compileToV0Message());
    const r = await withTimeout(rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }), 8000);
    const v = r.value;
    return {
      ran: true, mode, ok: !v.err,
      error: v.err ? explainSimError(v.err, v.logs) : null,
      unitsConsumed: v.unitsConsumed ?? null,
      logs: (v.logs || []).slice(-8),
      cluster: new URL(rpc.rpcEndpoint).host,
    };
  } catch (e) {
    return { ran: false, mode, ok: false, error: 'simulation unavailable: ' + String(e.message || e).slice(0, 160) };
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`RPC timed out after ${ms} ms`)), ms))]);
}

// Prefer the program's own log line ("Transfer: insufficient lamports …") over raw error JSON.
function explainSimError(err, logs = []) {
  const line = [...(logs || [])].reverse().find(l => !/^Program \w+ (invoke|success|consumed)/.test(l) && !/failed: custom program error/.test(l));
  const raw = JSON.stringify(err);
  if (!line) return raw;
  const m = line.match(/insufficient lamports (\d+), need (\d+)/);
  if (m) return `the vault holds ${+(m[1] / 1e9).toFixed(9)} SOL but the transfer needs ${+(m[2] / 1e9).toFixed(9)} SOL (${raw})`;
  return `${line.replace(/^Program log: /, '')} (${raw})`;
}
