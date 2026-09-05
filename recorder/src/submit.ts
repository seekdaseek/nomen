import { config, log } from './config.ts';
import { attestedHead, fetchProof, isProcessed, nomen, parseCreditEvents, queryId, recordArgs, revertReason, signer, type Proof } from './creditcoin.ts';
import { KINDS, KIND_PRIORITY, PROTOCOLS, insertOnchainOnly, insertSubmission, markAttested, now, queue, requeueFailed, rowsForTx, setFailed, setMeta, setProven, setRecorded, setRowFailed, setRowRecorded, type EventRow, type Kind } from './db.ts';

const KIND_INDEX: Record<Kind, number> = { Borrow: 0, Repay: 1, Liquidation: 2 };

interface Prepared { ethTx: string; kind: Kind; rows: EventRow[]; proof: Proof; gasEstimate: bigint }

/** Fresh proof -> already-on-chain check -> estimateGas (a revert here costs nothing). Re-fetches the proof once on failure. */
async function prepare(ethTx: string): Promise<Prepared | 'skipped' | null> {
  const rows = rowsForTx(ethTx).filter((r) => r.state === 'attested' || r.state === 'proven');
  if (rows.length === 0) return 'skipped';
  const kind = [...rows].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])[0].kind;

  const pr = await fetchProof(ethTx);
  if (!pr.ok) {
    setFailed(ethTx, `${pr.retriable ? '' : 'permanent:'}prover:${pr.code} ${pr.message}`);
    log(`prover ${ethTx.slice(0, 12)}: ${pr.code} ${pr.message.slice(0, 80)}`);
    return null;
  }
  let proof = pr.proof;
  setProven(ethTx, proof.txIndex, proof.continuityProof.roots.length, (proof.txBytes.length - 2) / 2);

  if (await isProcessed(queryId(proof.chainKey, proof.headerNumber, proof.txIndex))) {
    setRecorded(ethTx, null, null, null, 'already_on_chain');
    log(`already on chain: ${ethTx.slice(0, 12)}`);
    return 'skipped';
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const est: bigint = await nomen!.record.estimateGas(...recordArgs(KIND_INDEX[kind], proof));
      return { ethTx, kind, rows, proof, gasEstimate: est };
    } catch (e) {
      const reason = revertReason(e);
      if (attempt === 0) {
        const again = await fetchProof(ethTx);
        if (again.ok) proof = again.proof;
        log(`estimate ${ethTx.slice(0, 12)} failed: ${reason.slice(0, 80)}; re-fetched proof (roots ${proof.continuityProof.roots.length})`);
        continue;
      }
      const permanent = /NoCreditEvent|TransactionFailed|InvalidKind|WrongChain|UnsupportedTransactionType|AmountTooLarge/.test(reason);
      setFailed(ethTx, `${permanent ? 'permanent:' : ''}estimate:${reason}`);
      insertSubmission({ ethTx, kind, ccTx: null, status: 'estimate_failed', gasEstimate: null, gasUsed: null, gasPriceWei: null, roots: proof.continuityProof.roots.length, bytes: (proof.txBytes.length - 2) / 2, onchainEvents: null, ledgerRows: rows.length, error: reason, sentAt: now(), minedAt: null });
    }
  }
  return null;
}

/** Reconcile ledger rows with the CreditEvents the contract actually emitted; unmatched rows are failed, extra events are kept flagged. */
function reconcile(p: Prepared, ccTx: string, ccBlock: number, gasUsed: number, events: { borrower: string; kind: bigint; protocol: bigint; amount: bigint; marketOrAsset: string }[]): number {
  const unused = events.map((e) => ({ ...e, used: false }));
  let matched = 0;
  for (const r of p.rows) {
    const ev = unused.find((e) => !e.used && e.borrower.toLowerCase() === r.borrower.toLowerCase() && KINDS[Number(e.kind)] === r.kind && e.amount.toString() === r.amount);
    if (ev) { ev.used = true; setRowRecorded(r.id, ccTx, ccBlock, gasUsed); matched++; }
    else setRowFailed(r.id, 'permanent:not_in_receipt (contract did not emit this event)');
  }
  unused.filter((e) => !e.used).forEach((e, i) => {
    insertOnchainOnly({ ethTx: p.ethTx, syntheticLogIndex: 100_000 + i, ethBlock: p.proof.headerNumber, txIndex: p.proof.txIndex, protocol: PROTOCOLS[Number(e.protocol)], kind: KINDS[Number(e.kind)], borrower: e.borrower, amount: e.amount.toString(), marketOrAsset: e.marketOrAsset.toLowerCase(), token: null, ccTx, ccBlock, gasUsed });
  });
  return matched;
}

export interface SubmitStats { attestedHead: number; newlyAttested: number; requeued: number; prepared: number; sent: number; recorded: number; failed: number }

export async function submitOnce(): Promise<SubmitStats> {
  const head = await attestedHead();
  setMeta('attested_head', String(head));
  const newlyAttested = markAttested(head);
  const requeued = requeueFailed(4, new Date(Date.now() - 5 * 60_000).toISOString());
  const stats: SubmitStats = { attestedHead: head, newlyAttested, requeued, prepared: 0, sent: 0, recorded: 0, failed: 0 };

  const txs: string[] = [];
  for (const r of queue(config.batch * 6)) if (!txs.includes(r.eth_tx)) txs.push(r.eth_tx);
  const chosen = txs.slice(0, config.batch);
  if (chosen.length === 0) return stats;
  if (!nomen || !signer) { log('no signer configured; not submitting'); return stats; }

  const prepared: Prepared[] = [];
  for (const tx of chosen) {
    const p = await prepare(tx);
    if (p === 'skipped') continue;
    if (p) prepared.push(p); else stats.failed++;
  }
  stats.prepared = prepared.length;
  if (config.dryRun) {
    for (const p of prepared) log(`dry-run: would record ${p.ethTx} kind=${p.kind} rows=${p.rows.length} est=${p.gasEstimate} roots=${p.proof.continuityProof.roots.length} bytes=${(p.proof.txBytes.length - 2) / 2}`);
    return stats;
  }

  // Send every prepared proof with consecutive nonces, then wait for all receipts: several records per 15 s block.
  const inflight: { p: Prepared; tx: { hash: string; wait: (c?: number, t?: number) => Promise<import('ethers').TransactionReceipt | null> }; sentAt: string }[] = [];
  for (const p of prepared) {
    const sentAt = now();
    try {
      const tx = await nomen.record(...recordArgs(KIND_INDEX[p.kind], p.proof), { gasLimit: (p.gasEstimate * 135n) / 100n });
      inflight.push({ p, tx, sentAt });
      stats.sent++;
    } catch (e) {
      const reason = revertReason(e);
      setFailed(p.ethTx, `send:${reason}`);
      insertSubmission({ ethTx: p.ethTx, kind: p.kind, ccTx: null, status: 'send_failed', gasEstimate: Number(p.gasEstimate), gasUsed: null, gasPriceWei: null, roots: p.proof.continuityProof.roots.length, bytes: (p.proof.txBytes.length - 2) / 2, onchainEvents: null, ledgerRows: p.rows.length, error: reason, sentAt, minedAt: null });
      stats.failed++;
      if (/nonce/i.test(reason)) signer.reset();
      log(`send ${p.ethTx.slice(0, 12)} failed: ${reason.slice(0, 100)}`);
    }
  }
  for (const { p, tx, sentAt } of inflight) {
    const roots = p.proof.continuityProof.roots.length, bytes = (p.proof.txBytes.length - 2) / 2;
    try {
      const rc = await tx.wait(1, 180_000);
      if (!rc) throw new Error('no receipt within 180 s');
      const evs = parseCreditEvents(rc).map((d) => ({ borrower: String(d.args.borrower), kind: d.args.kind as bigint, protocol: d.args.protocol as bigint, amount: d.args.amount as bigint, marketOrAsset: String(d.args.marketOrAsset) }));
      if (rc.status === 1) {
        const matched = reconcile(p, rc.hash, rc.blockNumber, Number(rc.gasUsed), evs);
        insertSubmission({ ethTx: p.ethTx, kind: p.kind, ccTx: rc.hash, status: 'mined', gasEstimate: Number(p.gasEstimate), gasUsed: Number(rc.gasUsed), gasPriceWei: rc.gasPrice.toString(), roots, bytes, onchainEvents: evs.length, ledgerRows: p.rows.length, error: matched === p.rows.length && evs.length === p.rows.length ? null : `matched ${matched}/${p.rows.length}, onchain ${evs.length}`, sentAt, minedAt: now() });
        stats.recorded += matched;
        log(`recorded ${p.ethTx.slice(0, 12)} ${p.kind} events=${evs.length}/${p.rows.length} gas=${rc.gasUsed} roots=${roots} bytes=${bytes} cc=${rc.hash.slice(0, 12)}`);
      } else {
        setFailed(p.ethTx, 'reverted on-chain after successful estimate');
        insertSubmission({ ethTx: p.ethTx, kind: p.kind, ccTx: rc.hash, status: 'reverted', gasEstimate: Number(p.gasEstimate), gasUsed: Number(rc.gasUsed), gasPriceWei: rc.gasPrice.toString(), roots, bytes, onchainEvents: 0, ledgerRows: p.rows.length, error: 'reverted', sentAt, minedAt: now() });
        stats.failed++;
        log(`REVERTED ${p.ethTx.slice(0, 12)} cc=${rc.hash}`);
      }
    } catch (e) {
      const reason = revertReason(e);
      setFailed(p.ethTx, `wait:${reason}`);
      insertSubmission({ ethTx: p.ethTx, kind: p.kind, ccTx: tx.hash, status: 'wait_failed', gasEstimate: Number(p.gasEstimate), gasUsed: null, gasPriceWei: null, roots, bytes, onchainEvents: null, ledgerRows: p.rows.length, error: reason, sentAt, minedAt: null });
      stats.failed++;
      signer.reset();
      log(`wait ${p.ethTx.slice(0, 12)} failed: ${reason.slice(0, 100)}`);
    }
  }
  setMeta('last_submit_at', now());
  return stats;
}
