import { ethers } from 'ethers';
import { config, log } from './config.ts';
import { blockNumber, decodeLog, POOLS, TOPIC, withProviders, morphoLoanToken, tokenMeta } from './eth.ts';
import { getEvent, insertEvent, setTokenForMarket, type EventRow, type NewEvent } from './db.ts';

const ALL_TOPICS = Object.values(TOPIC) as unknown as string[];

async function store(events: NewEvent[]): Promise<{ inserted: number; rows: EventRow[] }> {
  let inserted = 0;
  for (const e of events) {
    if (e.protocol === 'MorphoBlue' && !e.token) {
      e.token = await morphoLoanToken(e.marketOrAsset);
      if (e.token) setTokenForMarket(e.token, 'MorphoBlue', e.marketOrAsset);
    }
    if (e.token) void tokenMeta(e.token);
    if (insertEvent(e, 'self')) inserted++;
  }
  return { inserted, rows: events.map((e) => getEvent(e.ethTx, e.logIndex)).filter((r): r is EventRow => !!r) };
}

/** Self-submit one Ethereum transaction: its credit events go to the front of the queue. */
export async function submitTx(txHash: string): Promise<{ txHash: string; block: number | null; found: number; inserted: number; rows: EventRow[] }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('txHash must be 0x + 64 hex');
  const rc = await withProviders('receipt', (p) => p.getTransactionReceipt(txHash));
  if (!rc) return { txHash, block: null, found: 0, inserted: 0, rows: [] };
  const events = rc.logs.map(decodeLog).filter((e): e is NewEvent => !!e);
  const { inserted, rows } = await store(events);
  log(`self-submit tx ${txHash.slice(0, 12)}: ${events.length} credit events, ${inserted} new`);
  return { txHash, block: rc.blockNumber, found: events.length, inserted, rows };
}

/**
 * Self-submit an address: scan the last `blocks` Ethereum blocks for events where it is the borrower
 * (topic position 2 for Aave Borrow/Repay and Morpho Borrow, position 3 for Aave LiquidationCall, Morpho Repay/Liquidate).
 */
export async function submitAddress(address: string, blocks = 50_000): Promise<{ address: string; fromBlock: number; toBlock: number; found: number; inserted: number; rows: EventRow[] }> {
  const a = ethers.getAddress(address);
  const padded = ethers.zeroPadValue(a, 32);
  const head = await blockNumber();
  const toBlock = head - config.confirmations;
  const fromBlock = Math.max(1, toBlock - Math.min(Math.max(blocks, 1_000), 200_000));
  const found: NewEvent[] = [];
  for (let from = fromBlock; from <= toBlock; from += config.chunk) {
    const to = Math.min(toBlock, from + config.chunk - 1);
    const [p2, p3] = await Promise.all([
      withProviders(`self getLogs p2 ${from}`, (p) => p.getLogs({ address: Object.keys(POOLS), topics: [ALL_TOPICS, null, padded], fromBlock: from, toBlock: to })),
      withProviders(`self getLogs p3 ${from}`, (p) => p.getLogs({ address: Object.keys(POOLS), topics: [ALL_TOPICS, null, null, padded], fromBlock: from, toBlock: to })),
    ]);
    for (const l of [...p2, ...p3]) {
      const e = decodeLog(l);
      if (e && e.borrower.toLowerCase() === a.toLowerCase() && !found.some((f) => f.ethTx === e.ethTx && f.logIndex === e.logIndex)) found.push(e);
    }
  }
  const { inserted, rows } = await store(found);
  log(`self-submit address ${a}: blocks ${fromBlock}-${toBlock}, ${found.length} credit events, ${inserted} new`);
  return { address: a, fromBlock, toBlock, found: found.length, inserted, rows };
}
