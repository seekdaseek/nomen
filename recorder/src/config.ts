import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal in-app dotenv: <repo>/.env, shell env wins. Never logs values. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const num = (name: string, def: number): number => (process.env[name] ? Number(process.env[name]) : def);
const str = (name: string, def: string): string => process.env[name] ?? def;

let deployedAddress = '';
try {
  deployedAddress = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/cc3-testnet.json'), 'utf8')).address;
} catch {
  /* no deployment file: NOMEN_ADDRESS must be set */
}

export const config = {
  privateKey: str('CREDITCOIN_WALLET_PRIVATE_KEY', ''),
  nomenAddress: str('NOMEN_ADDRESS', deployedAddress),
  /** Comma-separated, tried in order per call; drpc serves 7,200-block eth_getLogs from some IPs and refuses others. */
  ethRpcUrls: str('ETH_RPC_URLS', 'https://eth.drpc.org,https://eth.api.onfinality.io/public,https://rpc.mevblocker.io').split(',').map((u) => u.trim()).filter(Boolean),
  ccRpcUrl: str('CREDITCOIN_RPC_URL', 'https://rpc.cc3-testnet.creditcoin.network'),
  proverUrl: str('PROVER_URL', 'https://prover.cc3-testnet.creditcoin.network'),
  port: num('NOMEN_PORT', 3023),
  dbPath: str('NOMEN_DB', path.join(ROOT, 'recorder', 'nomen.db')),
  /** First scan starts here; 0 = head minus one chunk at first start. */
  startBlock: num('NOMEN_START_BLOCK', 0),
  /** Blocks behind the Ethereum head the scanner stays; the prover's reorg window is 32. */
  confirmations: num('NOMEN_CONFIRMATIONS', 40),
  /** eth_getLogs span per call; drpc measured flaky above ~1,200. */
  chunk: num('NOMEN_CHUNK', 1200),
  /** Distinct proven transactions sent per submit batch (one CC3 block is 15 s). */
  batch: num('NOMEN_BATCH', 6),
  pollMs: num('NOMEN_POLL_MS', 30_000),
  priceRefreshMs: num('NOMEN_PRICE_REFRESH_MS', 3_600_000),
  dryRun: process.env.NOMEN_DRY_RUN === '1',
  userAgent: str('NOMEN_USER_AGENT', 'nomen-recorder/0.1 (+https://github.com/seekdaseek/nomen)'),
  sourceChainKey: 3,
} as const;

export function log(msg: string, ...rest: unknown[]): void {
  console.log(`${new Date().toISOString()} ${msg}`, ...rest);
}
