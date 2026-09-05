import { config, log } from './config.ts';
import { logWallet, walletBalance } from './creditcoin.ts';
import { countsByState, setMeta } from './db.ts';
import { refreshPrices } from './prices.ts';
import { startServer } from './server.ts';
import { submitOnce } from './submit.ts';
import { scanOnce } from './tail.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).slice(0, 200);

logWallet();
startServer();
let lastPrices = 0;

async function cycle(): Promise<void> {
  try { await scanOnce(); } catch (e) { log(`scan failed: ${msg(e)}`); }
  try {
    for (let i = 0; i < 4; i++) {
      const s = await submitOnce();
      if (i === 0 || s.prepared > 0) log(`submit: attestedHead=${s.attestedHead} newlyAttested=${s.newlyAttested} requeued=${s.requeued} prepared=${s.prepared} sent=${s.sent} recorded=${s.recorded} failed=${s.failed}`);
      if (s.prepared === 0) break;
    }
  } catch (e) { log(`submit failed: ${msg(e)}`); }
  if (Date.now() - lastPrices > config.priceRefreshMs) {
    try { await refreshPrices(); lastPrices = Date.now(); } catch (e) { log(`prices failed: ${msg(e)}`); }
  }
  setMeta('last_cycle_at', new Date().toISOString());
  log(`ledger ${JSON.stringify(countsByState())} balance=${await walletBalance().catch(() => '?')} CTC`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log(`${sig}: exiting`); process.exit(0); });

(async () => {
  for (;;) {
    await cycle();
    await sleep(config.pollMs);
  }
})();
