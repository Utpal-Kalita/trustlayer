import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
const keys = {};
for (const n of ['OWNER','AGENT','GATEKEEPER','VENDOR_A','ATTACKER']) {
  const kp = Keypair.generate();
  keys[n] = { public: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey) };
}
const env = ['# DEVNET-ONLY demo keys. No mainnet value. Never commit real keys.',
  'SOLANA_RPC=https://api.devnet.solana.com',
  ...Object.entries(keys).flatMap(([n,k]) => [`${n}_PUBKEY=${k.public}`, `${n}_SECRET=${k.secret}`])].join('\n');
fs.writeFileSync('.env', env, {mode: 0o600});
for (const [n,k] of Object.entries(keys)) console.log(n, k.public);
