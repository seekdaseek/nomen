import { ethers } from 'ethers';
import { config, log } from './config.ts';
import { getMarket, getToken, putMarket, putToken, type Kind, type Protocol, type NewEvent } from './db.ts';

export const POOLS: Record<string, Protocol> = {
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'AaveV3',
  '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb': 'MorphoBlue',
  '0xc13e21b648a5ee794902342038ff3adab66be987': 'Spark',
};
export const TOPIC = {
  AAVE_BORROW: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  AAVE_REPAY: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051',
  AAVE_LIQUIDATION: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286',
  MORPHO_BORROW: '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43',
  MORPHO_REPAY: '0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09',
  MORPHO_LIQUIDATE: '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41',
} as const;
const ALL_TOPICS = Object.values(TOPIC);

function makeProvider(url: string): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url);
  req.setHeader('user-agent', config.userAgent);
  req.timeout = 60_000;
  return new ethers.JsonRpcProvider(req, 1, { staticNetwork: true, batchMaxCount: 1 });
}
export const providers: { url: string; p: ethers.JsonRpcProvider }[] = config.ethRpcUrls.map((url) => ({ url, p: makeProvider(url) }));
/** Primary provider for one-off contract reads; log scanning rotates through all of them. */
export const eth = providers[0].p;
let preferred = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).slice(0, 120);

/**
 * Try the last provider that worked first, then the others; two attempts each with backoff.
 * drpc answers "Can't route your request" (code 12) deterministically from some IPs and intermittently from others.
 */
export async function withProviders<T>(label: string, fn: (p: ethers.JsonRpcProvider) => Promise<T>, attemptsEach = 2): Promise<T> {
  let last: unknown;
  for (let k = 0; k < providers.length; k++) {
    const idx = (preferred + k) % providers.length;
    const { url, p } = providers[idx];
    for (let i = 0; i < attemptsEach; i++) {
      try {
        const out = await fn(p);
        if (idx !== preferred) { log(`eth: switching to ${url}`); preferred = idx; }
        return out;
      } catch (e) {
        last = e;
        log(`eth ${label} via ${new URL(url).host} attempt ${i + 1}/${attemptsEach} failed: ${errMsg(e)}`);
        await sleep(1_500 * (i + 1));
      }
    }
  }
  throw last;
}

/** Same as withProviders for callers that already hold a contract bound to `eth`; rotates only on the primary. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; log(`eth ${label} attempt ${i + 1}/${tries} failed: ${errMsg(e)}`); await sleep(2_000 * 2 ** i); }
  }
  throw last;
}

export const blockNumber = (): Promise<number> => withProviders('blockNumber', (p) => p.getBlockNumber());

export function getLogsRange(fromBlock: number, toBlock: number): Promise<ethers.Log[]> {
  return withProviders(`getLogs ${fromBlock}-${toBlock}`, (p) =>
    p.getLogs({ address: Object.keys(POOLS), topics: [ALL_TOPICS as unknown as string[]], fromBlock, toBlock }));
}

const topicAddr = (t: string): string => ethers.getAddress('0x' + t.slice(26));

/** Mirrors Nomen._decode exactly: emitter allowlist, four topics, exact data length per layout. */
export function decodeLog(l: ethers.Log): NewEvent | null {
  const protocol = POOLS[l.address.toLowerCase()];
  if (!protocol || l.topics.length !== 4) return null;
  const t0 = l.topics[0].toLowerCase();
  const dlen = (l.data.length - 2) / 2;
  const word = (i: number): bigint => BigInt('0x' + l.data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  let kind: Kind, borrower: string, marketOrAsset: string, amount: bigint, token: string | null;
  if (protocol === 'MorphoBlue') {
    if (t0 === TOPIC.MORPHO_BORROW && dlen === 96) { kind = 'Borrow'; borrower = topicAddr(l.topics[2]); amount = word(1); }
    else if (t0 === TOPIC.MORPHO_REPAY && dlen === 64) { kind = 'Repay'; borrower = topicAddr(l.topics[3]); amount = word(0); }
    else if (t0 === TOPIC.MORPHO_LIQUIDATE && dlen === 160) { kind = 'Liquidation'; borrower = topicAddr(l.topics[3]); amount = word(0); }
    else return null;
    marketOrAsset = l.topics[1].toLowerCase();
    token = getMarket(marketOrAsset)?.loan_token ?? null; // resolved off-chain via idToMarketParams
  } else {
    if (t0 === TOPIC.AAVE_BORROW && dlen === 128) { kind = 'Borrow'; borrower = topicAddr(l.topics[2]); marketOrAsset = l.topics[1]; amount = word(1); }
    else if (t0 === TOPIC.AAVE_REPAY && dlen === 64) { kind = 'Repay'; borrower = topicAddr(l.topics[2]); marketOrAsset = l.topics[1]; amount = word(0); }
    else if (t0 === TOPIC.AAVE_LIQUIDATION && dlen === 128) { kind = 'Liquidation'; borrower = topicAddr(l.topics[3]); marketOrAsset = l.topics[2]; amount = word(0); }
    else return null;
    marketOrAsset = marketOrAsset.toLowerCase();
    token = topicAddr(marketOrAsset);
  }
  return { ethTx: l.transactionHash, logIndex: l.index, ethBlock: l.blockNumber, txIndex: l.transactionIndex ?? null, protocol, kind, borrower, amount, marketOrAsset, token };
}

const erc20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const erc20b32 = ['function symbol() view returns (bytes32)'];
const morphoAbi = ['function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)'];
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

/** ERC-20 symbol/decimals, cached forever in the ledger (some tokens return bytes32 symbols). */
export async function tokenMeta(address: string): Promise<{ symbol: string | null; decimals: number | null }> {
  const cached = getToken(address);
  if (cached) return { symbol: cached.symbol, decimals: cached.decimals };
  let symbol: string | null = null, decimals: number | null = null;
  try {
    decimals = Number(await withProviders('decimals', (p) => new ethers.Contract(address, erc20, p).decimals()));
    try { symbol = await withProviders('symbol', (p) => new ethers.Contract(address, erc20, p).symbol(), 1); }
    catch { symbol = ethers.decodeBytes32String(await withProviders('symbol32', (p) => new ethers.Contract(address, erc20b32, p).symbol(), 1)); }
  } catch (e) {
    log(`tokenMeta ${address} failed: ${(e as Error).message.slice(0, 80)}`);
  }
  putToken(address, symbol, decimals);
  return { symbol, decimals };
}

/** Morpho market Id -> loan token, cached forever. */
export async function morphoLoanToken(id: string): Promise<string | null> {
  const cached = getMarket(id);
  if (cached) return cached.loan_token;
  try {
    const p = await withProviders('idToMarketParams', (pr) => new ethers.Contract(MORPHO, morphoAbi, pr).idToMarketParams(id));
    const loan = ethers.getAddress(p.loanToken), coll = ethers.getAddress(p.collateralToken);
    putMarket(id, loan, coll);
    return loan;
  } catch (e) {
    log(`idToMarketParams ${id} failed: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}
