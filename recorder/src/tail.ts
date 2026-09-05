import { config, log } from './config.ts';
import { blockNumber, decodeLog, getLogsRange, morphoLoanToken, tokenMeta } from './eth.ts';
import { getMeta, insertEvent, setMeta, setTokenForMarket } from './db.ts';
import type { NewEvent } from './db.ts';

/** Resolve Morpho markets and token metadata AFTER the rows are stored, with bounded concurrency and a time cap. */
async function resolveMetadata(events: NewEvent[]): Promise<void> {
  const markets = [...new Set(events.filter((e) => e.protocol === 'MorphoBlue' && !e.token).map((e) => e.marketOrAsset))];
  const tokens = new Set(events.map((e) => e.token).filter((t): t is string => !!t));
  const deadline = Date.now() + 90_000;
  for (const id of markets) {
    if (Date.now() > deadline) { log(`metadata: time cap hit, ${markets.length} markets pending resolve next cycle`); break; }
    const loan = await morphoLoanToken(id);
    if (loan) { setTokenForMarket(loan, 'MorphoBlue', id); tokens.add(loan); }
  }
  for (const t of tokens) {
    if (Date.now() > deadline) break;
    await tokenMeta(t);
  }
}

/** Tail the three pools from the stored cursor up to head - confirmations, one chunk per call. */
export async function scanOnce(): Promise<{ cursor: number; head: number; inserted: number }> {
  const head = await blockNumber();
  const target = head - config.confirmations;
  let cursor = Number(getMeta('cursor') ?? 0);
  if (!cursor) {
    cursor = config.startBlock > 0 ? config.startBlock - 1 : target - config.chunk;
    log(`scanner: first start, cursor ${cursor}`);
  }
  let inserted = 0;
  let calls = 0;
  while (cursor < target && calls < 10) {
    const from = cursor + 1;
    const to = Math.min(target, cursor + config.chunk);
    const logs = await getLogsRange(from, to);
    calls++;
    const events: NewEvent[] = [];
    for (const l of logs) {
      const e = decodeLog(l);
      if (!e) continue;
      events.push(e);
      if (insertEvent(e)) inserted++;
    }
    cursor = to;
    setMeta('cursor', String(cursor));
    setMeta('last_scan_at', new Date().toISOString());
    setMeta('eth_head', String(head));
    log(`scanner: blocks ${from}-${to} logs=${logs.length} new=${inserted} (head ${head}, target ${target})`);
    try { await resolveMetadata(events); } catch (e) { log(`metadata failed: ${(e as Error).message.slice(0, 120)}`); }
  }
  return { cursor, head, inserted };
}
