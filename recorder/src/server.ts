import http from 'node:http';
import { ethers } from 'ethers';
import { config, log } from './config.ts';
import { byBorrower, countsByKindProtocol, countsByState, distinctRecordedBorrowers, getMeta, lastSubmissions, recent, recordedRows, recordedSpan, type EventRow } from './db.ts';
import { nomenRead, walletBalance } from './creditcoin.ts';
import { usdValue } from './prices.ts';
import { tokenMeta } from './eth.ts';
import { submitAddress, submitTx } from './selfsubmit.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
};

async function rowView(r: EventRow) {
  const v = await usdValue(r.token, BigInt(r.amount));
  return { ...r, symbol: v.symbol, units: v.units, usd: v.usd, usdMethod: v.method };
}

let totalsCache: { at: number; body: unknown } | null = null;
async function totals() {
  if (totalsCache && Date.now() - totalsCache.at < 30_000) return totalsCache.body;
  const rows = recordedRows();
  const usd = { borrowed: 0, repaid: 0, liquidated: 0, pricedRows: 0, unpricedRows: 0 };
  const byProtocolKind: Record<string, number> = {};
  for (const r of rows) {
    byProtocolKind[`${r.protocol}.${r.kind}`] = (byProtocolKind[`${r.protocol}.${r.kind}`] ?? 0) + 1;
    const v = await usdValue(r.token, BigInt(r.amount));
    if (v.usd === null) { usd.unpricedRows++; continue; }
    usd.pricedRows++;
    if (r.kind === 'Borrow') usd.borrowed += v.usd; else if (r.kind === 'Repay') usd.repaid += v.usd; else usd.liquidated += v.usd;
  }
  const span = recordedSpan();
  const days = span.first && span.last ? Math.max(1, Math.round(((Date.parse(span.last) - Date.parse(span.first)) / 86_400_000) * 10) / 10) : 0;
  let onchain: unknown = null;
  try { const t = await nomenRead.totals(); onchain = { events: Number(t[0]), byKind: t[1].map(Number), byProtocol: t[2].map(Number), borrowers: Number(t[3]) }; } catch { /* rpc hiccup */ }
  const counts = countsByState();
  const kinds = { Borrow: 0, Repay: 0, Liquidation: 0 };
  for (const [k, n] of Object.entries(byProtocolKind)) kinds[k.split('.')[1] as keyof typeof kinds] += n;
  const body = {
    headline: `${rows.length} credit events proven from Ethereum mainnet onto Creditcoin over ${days} days, across three lending protocols: ${kinds.Borrow} loans opened, ${kinds.Repay} repayments, ${kinds.Liquidation} liquidations, $${Math.round(usd.borrowed + usd.repaid + usd.liquidated).toLocaleString('en-US')} notional (${usd.pricedRows} of ${rows.length} events priced). ${distinctRecordedBorrowers()} borrowers scored.`,
    recorded: rows.length, byKind: kinds, byProtocolKind, borrowers: distinctRecordedBorrowers(),
    usd: { ...usd, total: usd.borrowed + usd.repaid + usd.liquidated, method: 'stablecoins (USDC, USDT, DAI, USDS, USDe, GHO) at 1.00; WETH at Chainlink ETH/USD; wstETH at ETH/USD x stEthPerToken; WBTC and cbBTC at Chainlink BTC/USD; all read on Ethereum mainnet at one stated block, refreshed hourly; everything else counted in units only' },
    ledger: { counts, byProtocolKindState: countsByKindProtocol() },
    span: { firstEthBlock: span.lo, lastEthBlock: span.hi, firstRecordedAt: span.first, lastRecordedAt: span.last, days },
    onchain, contract: config.nomenAddress, compound: 'Compound v3 is excluded: Comet Supply/Withdraw are borrow/repay only depending on account state, and Attestcoin proves transactions, not state.',
  };
  totalsCache = { at: Date.now(), body };
  return body;
}

async function borrower(addr: string) {
  const a = ethers.getAddress(addr);
  const rows = await Promise.all(byBorrower(a).map(rowView));
  let onchain: unknown = null;
  try {
    const [h, s] = await Promise.all([nomenRead.history(a), nomenRead.score(a)]);
    onchain = { borrows: Number(h.borrows), repays: Number(h.repays), liquidations: Number(h.liquidations), borrowed: h.borrowed.toString(), repaid: h.repaid.toString(), liquidated: h.liquidated.toString(), firstEthBlock: Number(h.firstEthBlock), lastEthBlock: Number(h.lastEthBlock), lastLiquidationBlock: Number(h.lastLiquidationBlock), score: Number(s.value), grade: String.fromCharCode(Number(s.grade)) };
  } catch { /* rpc hiccup */ }
  return { address: a, onchain, events: rows, scoreFormula: 'no history -> 0/N; base 500; +min(200, repays*10); +50 if borrows>0 and no liquidation; -150 per liquidation decaying linearly over 2,628,000 Ethereum blocks since the last one; clamp 0..1000; A>=700 B>=600 C>=500 D>=350 else E' };
}

export function startServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const page = fs.readFileSync(path.join(ROOT, 'recorder', 'public', 'nomen-index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (url.pathname === '/submit' && req.method === 'POST') {
        const body = await new Promise<string>((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) reject(new Error('body too large')); }); req.on('end', () => resolve(b)); req.on('error', reject); });
        const input = JSON.parse(body || '{}') as { txHash?: string; address?: string; blocks?: number };
        if (input.txHash) return json(res, 200, await submitTx(input.txHash));
        if (input.address) return json(res, 200, await submitAddress(input.address, Number(input.blocks ?? 50_000)));
        return json(res, 400, { error: 'send {"txHash": "0x…"} or {"address": "0x…", "blocks": 50000}' });
      }
      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, dryRun: config.dryRun, cursor: Number(getMeta('cursor') ?? 0), ethHead: Number(getMeta('eth_head') ?? 0), attestedHead: Number(getMeta('attested_head') ?? 0), lastScanAt: getMeta('last_scan_at'), lastSubmitAt: getMeta('last_submit_at'), counts: countsByState(), balanceCTC: await walletBalance() });
      }
      if (url.pathname === '/totals') return json(res, 200, await totals());
      if (url.pathname === '/recent') return json(res, 200, await Promise.all(recent(Math.min(200, Number(url.searchParams.get('n') ?? 50))).map(rowView)));
      if (url.pathname === '/submissions') return json(res, 200, lastSubmissions(Math.min(200, Number(url.searchParams.get('n') ?? 20))));
      const m = url.pathname.match(/^\/borrower\/(0x[0-9a-fA-F]{40})$/);
      if (m) return json(res, 200, await borrower(m[1]));
      const t = url.pathname.match(/^\/token\/(0x[0-9a-fA-F]{40})$/);
      if (t) return json(res, 200, await tokenMeta(t[1]));
      json(res, 404, { error: 'not found', routes: ['/health', '/totals', '/recent?n=50', '/borrower/:address', '/submissions?n=20', 'POST /submit'] });
    } catch (e) {
      json(res, (e as Error).message.includes('must be') ? 400 : 500, { error: (e as Error).message });
    }
  });
  server.listen(config.port, '127.0.0.1', () => log(`http listening on 127.0.0.1:${config.port}`));
}
