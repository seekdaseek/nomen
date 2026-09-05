import { config, log } from './config.ts';
import { blockNumber, decodeLog, getLogsRange, morphoLoanToken, tokenMeta } from './eth.ts';
import { getMeta, insertEvent, setMeta, setTokenForMarket } from './db.ts';

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
    for (const l of logs) {
      const e = decodeLog(l);
      if (!e) continue;
      if (e.protocol === 'MorphoBlue' && !e.token) {
        e.token = await morphoLoanToken(e.marketOrAsset);
        if (e.token) setTokenForMarket(e.token, 'MorphoBlue', e.marketOrAsset);
      }
      if (e.token) void tokenMeta(e.token);
      if (insertEvent(e)) inserted++;
    }
    cursor = to;
    setMeta('cursor', String(cursor));
    log(`scanner: blocks ${from}-${to} logs=${logs.length} new=${inserted} (head ${head}, target ${target})`);
  }
  setMeta('last_scan_at', new Date().toISOString());
  setMeta('eth_head', String(head));
  return { cursor, head, inserted };
}
