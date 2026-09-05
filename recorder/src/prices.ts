import { ethers } from 'ethers';
import { log } from './config.ts';
import { withProviders, tokenMeta } from './eth.ts';
import { insertPrice, latestPrice } from './db.ts';

/**
 * USD notional method (labelled in every API response):
 *  - stablecoins at 1.00: USDC, USDT, DAI, USDS, USDe, GHO
 *  - WETH at Chainlink ETH/USD; wstETH at Chainlink ETH/USD x wstETH.stEthPerToken(); WBTC and cbBTC at Chainlink BTC/USD
 *    all read on Ethereum mainnet at one stated block and time, refreshed hourly
 *  - anything else: units only, no USD
 */
export const STABLE = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f', // USDS
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', // USDe
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', // GHO
]);
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
/** Chainlink Feed Registry on Ethereum mainnet; feeds are resolved from it at run time, never hard-coded. */
const REGISTRY = ethers.getAddress('0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf');
const DENOM = { BTC: ethers.getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), ETH: ethers.getAddress('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), USD: ethers.getAddress('0x0000000000000000000000000000000000000348') };
const registryAbi = ['function getFeed(address base, address quote) view returns (address)'];
const feedAbi = ['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)', 'function decimals() view returns (uint8)', 'function description() view returns (string)'];

export async function refreshPrices(): Promise<void> {
  const block = await withProviders('blockNumber', (p) => p.getBlockNumber());
  for (const asset of ['ETH', 'BTC'] as const) {
    const feed: string = await withProviders(`registry ${asset}/USD`, (p) => new ethers.Contract(REGISTRY, registryAbi, p).getFeed(DENOM[asset], DENOM.USD));
    const [rd, dec, desc] = await withProviders(`chainlink ${asset}`, (p) => { const c = new ethers.Contract(feed, feedAbi, p); return Promise.all([c.latestRoundData({ blockTag: block }), c.decimals(), c.description()]); });
    const usd = Number(rd.answer) / 10 ** Number(dec);
    insertPrice(asset, usd, `Chainlink Feed Registry ${REGISTRY} -> ${feed} (${desc})`, block, new Date(Number(rd.updatedAt) * 1000).toISOString());
    log(`price ${asset} ${usd} (${desc} ${feed}, feed updated ${new Date(Number(rd.updatedAt) * 1000).toISOString()}, block ${block})`);
  }
  const rate = Number(await withProviders('stEthPerToken', (p) => new ethers.Contract(ethers.getAddress(WSTETH), ['function stEthPerToken() view returns (uint256)'], p).stEthPerToken({ blockTag: block }))) / 1e18;
  insertPrice('WSTETH_PER_STETH', rate, `wstETH.stEthPerToken() ${WSTETH}`, block, null);
  log(`price wstETH/stETH ${rate} (block ${block})`);
}

export interface UsdValue { usd: number | null; method: string; symbol: string | null; units: number | null }

/** USD for one amount of one token, or null with the reason. */
export async function usdValue(token: string | null, amount: bigint): Promise<UsdValue> {
  if (!token) return { usd: null, method: 'token unknown (Morpho market unresolved)', symbol: null, units: null };
  const t = token.toLowerCase();
  const meta = await tokenMeta(token);
  if (meta.decimals === null) return { usd: null, method: 'decimals unavailable, units only', symbol: meta.symbol, units: null };
  const units = Number(amount) / 10 ** meta.decimals;
  if (STABLE.has(t)) return { usd: units, method: 'stablecoin at 1.00', symbol: meta.symbol, units };
  const ethP = latestPrice('ETH'), btcP = latestPrice('BTC'), rate = latestPrice('WSTETH_PER_STETH');
  if (t === WETH && ethP) return { usd: units * ethP.usd, method: `Chainlink ETH/USD ${ethP.usd} at block ${ethP.eth_block} (${ethP.fetched_at})`, symbol: meta.symbol, units };
  if (t === WSTETH && ethP && rate) return { usd: units * rate.usd * ethP.usd, method: `Chainlink ETH/USD ${ethP.usd} x stEthPerToken ${rate.usd} at block ${ethP.eth_block} (${ethP.fetched_at})`, symbol: meta.symbol, units };
  if ((t === WBTC || t === CBBTC) && btcP) return { usd: units * btcP.usd, method: `Chainlink BTC/USD ${btcP.usd} at block ${btcP.eth_block} (${btcP.fetched_at})`, symbol: meta.symbol, units };
  return { usd: null, method: 'not priced, units only', symbol: meta.symbol, units };
}
