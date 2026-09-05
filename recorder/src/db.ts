import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

export const KINDS = ['Borrow', 'Repay', 'Liquidation'] as const;
export type Kind = (typeof KINDS)[number];
export const PROTOCOLS = ['AaveV3', 'MorphoBlue', 'Spark'] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export type State = 'seen' | 'attested' | 'proven' | 'recorded' | 'failed';
/** Priority when submitting: liquidations first, then borrows, then repays. */
export const KIND_PRIORITY: Record<Kind, number> = { Liquidation: 0, Borrow: 1, Repay: 2 };

export interface EventRow {
  id: number;
  eth_tx: string;
  log_index: number;
  eth_block: number;
  tx_index: number | null;
  protocol: Protocol;
  kind: Kind;
  borrower: string;
  amount: string;
  market_or_asset: string;
  token: string | null;
  state: State;
  reason: string | null;
  attempts: number;
  proof_roots: number | null;
  proof_bytes: number | null;
  cc_tx: string | null;
  cc_block: number | null;
  gas_used: number | null;
  seen_at: string;
  attested_at: string | null;
  proven_at: string | null;
  recorded_at: string | null;
  failed_at: string | null;
}

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  eth_tx TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  eth_block INTEGER NOT NULL,
  tx_index INTEGER,
  protocol TEXT NOT NULL,
  kind TEXT NOT NULL,
  borrower TEXT NOT NULL,
  amount TEXT NOT NULL,
  market_or_asset TEXT NOT NULL,
  token TEXT,
  state TEXT NOT NULL DEFAULT 'seen',
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  proof_roots INTEGER,
  proof_bytes INTEGER,
  cc_tx TEXT,
  cc_block INTEGER,
  gas_used INTEGER,
  seen_at TEXT NOT NULL,
  attested_at TEXT,
  proven_at TEXT,
  recorded_at TEXT,
  failed_at TEXT,
  UNIQUE(eth_tx, log_index)
);
CREATE INDEX IF NOT EXISTS events_state ON events(state, eth_block);
CREATE INDEX IF NOT EXISTS events_borrower ON events(borrower);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  eth_tx TEXT NOT NULL,
  kind TEXT NOT NULL,
  cc_tx TEXT,
  status TEXT NOT NULL,
  gas_estimate INTEGER,
  gas_used INTEGER,
  gas_price_wei TEXT,
  proof_roots INTEGER,
  proof_bytes INTEGER,
  onchain_events INTEGER,
  ledger_rows INTEGER,
  error TEXT,
  sent_at TEXT NOT NULL,
  mined_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, symbol TEXT, decimals INTEGER, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, loan_token TEXT, collateral_token TEXT, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY,
  asset TEXT NOT NULL,
  usd REAL NOT NULL,
  source TEXT NOT NULL,
  eth_block INTEGER NOT NULL,
  source_updated_at TEXT,
  fetched_at TEXT NOT NULL
);
`);

export const now = (): string => new Date().toISOString();

const stmts = {
  insertEvent: db.prepare(`INSERT OR IGNORE INTO events
    (eth_tx, log_index, eth_block, tx_index, protocol, kind, borrower, amount, market_or_asset, token, state, reason, seen_at, failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  countsByState: db.prepare('SELECT state, COUNT(*) AS n FROM events GROUP BY state'),
  markAttested: db.prepare(`UPDATE events SET state = 'attested', attested_at = ? WHERE state = 'seen' AND eth_block <= ?`),
  queue: db.prepare(`SELECT * FROM events WHERE state IN ('attested', 'proven')
    ORDER BY CASE kind WHEN 'Liquidation' THEN 0 WHEN 'Borrow' THEN 1 ELSE 2 END, eth_block ASC, id ASC LIMIT ?`),
  rowsForTx: db.prepare('SELECT * FROM events WHERE eth_tx = ? ORDER BY log_index'),
  setProven: db.prepare(`UPDATE events SET state = 'proven', proven_at = ?, tx_index = ?, proof_roots = ?, proof_bytes = ?, reason = NULL WHERE eth_tx = ? AND state IN ('attested','proven')`),
  setRecorded: db.prepare(`UPDATE events SET state = 'recorded', recorded_at = ?, cc_tx = ?, cc_block = ?, gas_used = ?, reason = ? WHERE eth_tx = ? AND state IN ('attested','proven','failed')`),
  setFailed: db.prepare(`UPDATE events SET state = 'failed', failed_at = ?, reason = ?, attempts = attempts + 1 WHERE eth_tx = ? AND state IN ('attested','proven')`),
  requeue: db.prepare(`UPDATE events SET state = 'attested', reason = reason || ' (retry)' WHERE state = 'failed' AND attempts < ? AND failed_at < ?
    AND reason NOT LIKE 'zero_amount%' AND reason NOT LIKE 'no_credit_event%' AND reason NOT LIKE 'permanent:%'`),
  insertSubmission: db.prepare(`INSERT INTO submissions (eth_tx, kind, cc_tx, status, gas_estimate, gas_used, gas_price_wei, proof_roots, proof_bytes, onchain_events, ledger_rows, error, sent_at, mined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getToken: db.prepare('SELECT * FROM tokens WHERE address = ?'),
  putToken: db.prepare('INSERT OR REPLACE INTO tokens (address, symbol, decimals, fetched_at) VALUES (?, ?, ?, ?)'),
  getMarket: db.prepare('SELECT * FROM markets WHERE id = ?'),
  putMarket: db.prepare('INSERT OR REPLACE INTO markets (id, loan_token, collateral_token, fetched_at) VALUES (?, ?, ?, ?)'),
  setTokenForMarket: db.prepare('UPDATE events SET token = ? WHERE protocol = ? AND market_or_asset = ? AND token IS NULL'),
  latestPrice: db.prepare('SELECT * FROM prices WHERE asset = ? ORDER BY id DESC LIMIT 1'),
  insertPrice: db.prepare('INSERT INTO prices (asset, usd, source, eth_block, source_updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)'),
  recent: db.prepare(`SELECT * FROM events WHERE state = 'recorded' ORDER BY recorded_at DESC, id DESC LIMIT ?`),
  byBorrower: db.prepare('SELECT * FROM events WHERE borrower = ? ORDER BY eth_block ASC, log_index ASC'),
  recordedRows: db.prepare(`SELECT protocol, kind, token, amount FROM events WHERE state = 'recorded'`),
  distinctRecordedBorrowers: db.prepare(`SELECT COUNT(DISTINCT borrower) AS n FROM events WHERE state = 'recorded'`),
  recordedSpan: db.prepare(`SELECT MIN(eth_block) AS lo, MAX(eth_block) AS hi, MIN(recorded_at) AS first, MAX(recorded_at) AS last FROM events WHERE state = 'recorded'`),
  countsByKindProtocol: db.prepare(`SELECT protocol, kind, state, COUNT(*) AS n FROM events GROUP BY protocol, kind, state`),
  lastSubmissions: db.prepare('SELECT * FROM submissions ORDER BY id DESC LIMIT ?'),
  setRowRecorded: db.prepare(`UPDATE events SET state = 'recorded', recorded_at = ?, cc_tx = ?, cc_block = ?, gas_used = ?, reason = NULL WHERE id = ?`),
  setRowFailed: db.prepare(`UPDATE events SET state = 'failed', failed_at = ?, reason = ?, attempts = attempts + 1 WHERE id = ?`),
  insertOnchainOnly: db.prepare(`INSERT OR IGNORE INTO events (eth_tx, log_index, eth_block, tx_index, protocol, kind, borrower, amount, market_or_asset, token, state, reason, seen_at, recorded_at, cc_tx, cc_block, gas_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', 'onchain_only', ?, ?, ?, ?, ?)`),
};

export interface NewEvent {
  ethTx: string; logIndex: number; ethBlock: number; txIndex: number | null; protocol: Protocol; kind: Kind;
  borrower: string; amount: bigint; marketOrAsset: string; token: string | null;
}

/** One row per observed event. A zero amount is a permanent failure the contract would also refuse. Never deletes. */
export function insertEvent(e: NewEvent): boolean {
  const zero = e.amount === 0n;
  const r = stmts.insertEvent.run(e.ethTx, e.logIndex, e.ethBlock, e.txIndex, e.protocol, e.kind, e.borrower, e.amount.toString(),
    e.marketOrAsset, e.token, zero ? 'failed' : 'seen', zero ? 'zero_amount' : null, now(), zero ? now() : null);
  return r.changes > 0;
}
export const getMeta = (k: string): string | null => (stmts.getMeta.get(k) as { value: string } | undefined)?.value ?? null;
export const setMeta = (k: string, v: string): void => { stmts.setMeta.run(k, v); };
export function countsByState(): Record<State, number> {
  const out: Record<State, number> = { seen: 0, attested: 0, proven: 0, recorded: 0, failed: 0 };
  for (const r of stmts.countsByState.all() as { state: State; n: number }[]) out[r.state] = r.n;
  return out;
}
export const markAttested = (attestedHead: number): number => Number(stmts.markAttested.run(now(), attestedHead).changes);
export const queue = (limit: number): EventRow[] => stmts.queue.all(limit) as EventRow[];
export const rowsForTx = (ethTx: string): EventRow[] => stmts.rowsForTx.all(ethTx) as EventRow[];
export const setProven = (ethTx: string, txIndex: number, roots: number, bytes: number): void => { stmts.setProven.run(now(), txIndex, roots, bytes, ethTx); };
export const setRecorded = (ethTx: string, ccTx: string | null, ccBlock: number | null, gasUsed: number | null, reason: string | null): void => { stmts.setRecorded.run(now(), ccTx, ccBlock, gasUsed, reason, ethTx); };
export const setFailed = (ethTx: string, reason: string): void => { stmts.setFailed.run(now(), reason.slice(0, 300), ethTx); };
export const requeueFailed = (maxAttempts: number, olderThanIso: string): number => Number(stmts.requeue.run(maxAttempts, olderThanIso).changes);
export function insertSubmission(s: { ethTx: string; kind: Kind; ccTx: string | null; status: string; gasEstimate: number | null; gasUsed: number | null; gasPriceWei: string | null; roots: number; bytes: number; onchainEvents: number | null; ledgerRows: number; error: string | null; sentAt: string; minedAt: string | null }): void {
  stmts.insertSubmission.run(s.ethTx, s.kind, s.ccTx, s.status, s.gasEstimate, s.gasUsed, s.gasPriceWei, s.roots, s.bytes, s.onchainEvents, s.ledgerRows, s.error?.slice(0, 300) ?? null, s.sentAt, s.minedAt);
}
export const getToken = (a: string) => stmts.getToken.get(a.toLowerCase()) as { address: string; symbol: string | null; decimals: number | null } | undefined;
export const putToken = (a: string, symbol: string | null, decimals: number | null): void => { stmts.putToken.run(a.toLowerCase(), symbol, decimals, now()); };
export const getMarket = (id: string) => stmts.getMarket.get(id.toLowerCase()) as { id: string; loan_token: string | null; collateral_token: string | null } | undefined;
export const putMarket = (id: string, loan: string | null, coll: string | null): void => { stmts.putMarket.run(id.toLowerCase(), loan, coll, now()); };
export const setTokenForMarket = (token: string, protocol: Protocol, marketOrAsset: string): void => { stmts.setTokenForMarket.run(token, protocol, marketOrAsset); };
export const latestPrice = (asset: string) => stmts.latestPrice.get(asset) as { asset: string; usd: number; source: string; eth_block: number; source_updated_at: string | null; fetched_at: string } | undefined;
export const insertPrice = (asset: string, usd: number, source: string, ethBlock: number, sourceUpdatedAt: string | null): void => { stmts.insertPrice.run(asset, usd, source, ethBlock, sourceUpdatedAt, now()); };
export const recent = (n: number): EventRow[] => stmts.recent.all(n) as EventRow[];
export const byBorrower = (a: string): EventRow[] => stmts.byBorrower.all(a) as EventRow[];
export const recordedRows = () => stmts.recordedRows.all() as { protocol: Protocol; kind: Kind; token: string | null; amount: string }[];
export const distinctRecordedBorrowers = (): number => (stmts.distinctRecordedBorrowers.get() as { n: number }).n;
export const recordedSpan = () => stmts.recordedSpan.get() as { lo: number | null; hi: number | null; first: string | null; last: string | null };
export const countsByKindProtocol = () => stmts.countsByKindProtocol.all() as { protocol: Protocol; kind: Kind; state: State; n: number }[];
export const lastSubmissions = (n: number) => stmts.lastSubmissions.all(n) as Record<string, unknown>[];
export const setRowRecorded = (id: number, ccTx: string, ccBlock: number, gasUsed: number): void => { stmts.setRowRecorded.run(now(), ccTx, ccBlock, gasUsed, id); };
export const setRowFailed = (id: number, reason: string): void => { stmts.setRowFailed.run(now(), reason.slice(0, 300), id); };
/** The contract found a credit event our scanner did not have a row for: keep it, flagged, so the ledger stays the source of truth. */
export function insertOnchainOnly(e: { ethTx: string; syntheticLogIndex: number; ethBlock: number; txIndex: number; protocol: Protocol; kind: Kind; borrower: string; amount: string; marketOrAsset: string; token: string | null; ccTx: string; ccBlock: number; gasUsed: number }): void {
  const t = now();
  stmts.insertOnchainOnly.run(e.ethTx, e.syntheticLogIndex, e.ethBlock, e.txIndex, e.protocol, e.kind, e.borrower, e.amount, e.marketOrAsset, e.token, t, t, e.ccTx, e.ccBlock, e.gasUsed);
}
