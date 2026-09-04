// Submit one captured prover response (test/fixtures/<name>.json) to the deployed Nomen via record().
// Usage: node scripts/record_fixture.mjs <fixture-path> <kind 0|1|2>
// Env: CREDITCOIN_WALLET_PRIVATE_KEY (from .env), NOMEN_ADDRESS (or deployments/cc3-testnet.json), CREDITCOIN_RPC_URL.
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const [fixturePath, kindArg] = process.argv.slice(2);
if (!fixturePath || kindArg === undefined) { console.error('usage: record_fixture.mjs <fixture.json> <kind>'); process.exit(1); }
const kind = Number(kindArg);
const rpc = process.env.CREDITCOIN_RPC_URL || 'https://rpc.cc3-testnet.creditcoin.network';
const nomenAddress = process.env.NOMEN_ADDRESS || JSON.parse(fs.readFileSync(path.join(root, 'deployments/cc3-testnet.json'), 'utf8')).address;
const abi = JSON.parse(fs.readFileSync(path.join(root, 'out/Nomen.sol/Nomen.json'), 'utf8')).abi;
const proof = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const provider = new ethers.JsonRpcProvider(rpc, { chainId: 102031, name: 'cc3-testnet' }, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.CREDITCOIN_WALLET_PRIVATE_KEY, provider);
const nomen = new ethers.Contract(nomenAddress, abi, wallet);

const args = [kind, proof.chainKey, proof.headerNumber, proof.txBytes, proof.merkleProof.root,
  proof.merkleProof.siblings.map(s => [s.hash, s.isLeft]), proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots];

console.log(`record(kind=${kind}) tx=${proof.txHash} block=${proof.headerNumber} txBytes=${(proof.txBytes.length - 2) / 2}B siblings=${proof.merkleProof.siblings.length} roots=${proof.continuityProof.roots.length} -> ${nomenAddress}`);
let gasLimit;
try {
  const est = await nomen.record.estimateGas(...args);
  gasLimit = est * 135n / 100n;
  console.log(`estimateGas=${est} gasLimit=${gasLimit}`);
} catch (e) {
  console.log(`estimateGas failed (${e.shortMessage || e.message}); using 3,000,000`);
  gasLimit = 3_000_000n;
}
const before = await provider.getBalance(wallet.address);
const t0 = Date.now();
const tx = await nomen.record(...args, { gasLimit });
console.log(`sent ${tx.hash}`);
const rc = await tx.wait();
const after = await provider.getBalance(wallet.address);
const events = rc.logs.map(l => { try { return nomen.interface.parseLog(l); } catch { return null; } }).filter(e => e && e.name === 'CreditEvent');
console.log(`status=${rc.status} gasUsed=${rc.gasUsed} effectiveGasPrice=${rc.gasPrice} costCTC=${ethers.formatEther(before - after)} block=${rc.blockNumber} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const e of events) console.log(`CreditEvent borrower=${e.args.borrower} kind=${e.args.kind} protocol=${e.args.protocol} marketOrAsset=${e.args.marketOrAsset} amount=${e.args.amount} ethBlock=${e.args.ethBlock} queryId=${e.args.queryId}`);
const t = await nomen.totals();
console.log(`totals events=${t[0]} byKind=${t[1].map(String)} byProtocol=${t[2].map(String)} borrowers=${t[3]}`);
