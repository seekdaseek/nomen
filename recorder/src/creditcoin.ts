import { ethers } from 'ethers';
import { config, log } from './config.ts';

export const NOMEN_ABI = [
  'function record(uint8 kind, uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, (bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (bool)',
  'function processedQueries(bytes32) view returns (bool)',
  'function totals() view returns (uint64 events, uint64[3] byKind, uint64[3] byProtocol, uint64 borrowersScored)',
  'function history(address) view returns ((uint32 borrows, uint32 repays, uint32 liquidations, uint128 borrowed, uint128 repaid, uint128 liquidated, uint64 firstEthBlock, uint64 lastEthBlock, uint64 lastLiquidationBlock))',
  'function score(address) view returns (uint16 value, uint8 grade)',
  'function attestedEthHead() view returns (uint64 height, bool ok)',
  'event CreditEvent(address indexed borrower, uint8 kind, uint8 protocol, bytes32 marketOrAsset, uint256 amount, uint64 ethBlock, bytes32 queryId)',
  'error WrongChain(uint64 chainKey)', 'error InvalidKind(uint8 kind)', 'error UseRecord()', 'error UnsupportedTransactionType(uint8 txType)',
  'error TransactionFailed()', 'error NoCreditEvent()', 'error AmountTooLarge(uint256 amount)',
];
const CHAIN_INFO_ABI = [
  'function get_latest_attestation_height_and_hash(uint64 chainKey) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists) result)',
  'function is_height_attested(uint64 chainKey, uint64 targetHeight) view returns (bool)',
];

const ccReq = new ethers.FetchRequest(config.ccRpcUrl);
ccReq.setHeader('user-agent', config.userAgent);
ccReq.timeout = 60_000;
export const cc = new ethers.JsonRpcProvider(ccReq, { chainId: 102031, name: 'cc3-testnet' }, { staticNetwork: true, batchMaxCount: 1 });
export const wallet = config.privateKey ? new ethers.Wallet(config.privateKey, cc) : null;
export const signer = wallet ? new ethers.NonceManager(wallet) : null;
export const nomenRead = new ethers.Contract(config.nomenAddress, NOMEN_ABI, cc);
export const nomen = signer ? (nomenRead.connect(signer) as ethers.Contract) : null;
const chainInfo = new ethers.Contract('0x0000000000000000000000000000000000000fD3', CHAIN_INFO_ABI, cc);

export async function attestedHead(): Promise<number> {
  const r = await chainInfo.get_latest_attestation_height_and_hash(config.sourceChainKey);
  return Number(r.height ?? r[0]);
}

export interface Proof {
  chainKey: number; headerNumber: number; txIndex: number; txHash: string; txBytes: string;
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
  merkleProof: { root: string; siblings: { hash: string; isLeft: boolean }[] };
  cached: boolean; generatedAt: string;
}
export type ProofResult = { ok: true; proof: Proof } | { ok: false; code: string; message: string; retriable: boolean };

/** Fetch immediately before submitting: continuity roots change as attestations roll into checkpoints. */
export async function fetchProof(txHash: string): Promise<ProofResult> {
  const url = `${config.proverUrl}/api/v1/proof-by-tx/${config.sourceChainKey}/${txHash}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': config.userAgent }, signal: AbortSignal.timeout(45_000) });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof body.txBytes === 'string') return { ok: true, proof: body as unknown as Proof };
    const code = String(body.code ?? res.status);
    return { ok: false, code, message: String(body.message ?? ''), retriable: body.retriable === true || code === 'TxHashNotFound' || res.status >= 500 };
  } catch (e) {
    return { ok: false, code: 'network', message: (e as Error).message, retriable: true };
  }
}

/** Mirrors ASCBase._computeQueryId: keccak256(uint256 chainKey ‖ uint64 height ‖ uint256 txIndex). Verified against five on-chain queryIds. */
export function queryId(chainKey: number, height: number, txIndex: number): string {
  return ethers.keccak256(ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(chainKey), 32), ethers.zeroPadValue(ethers.toBeHex(height), 8), ethers.zeroPadValue(ethers.toBeHex(txIndex), 32),
  ]));
}

export const isProcessed = (qid: string): Promise<boolean> => nomenRead.processedQueries(qid) as Promise<boolean>;

export function recordArgs(kind: number, p: Proof): unknown[] {
  return [kind, p.chainKey, p.headerNumber, p.txBytes, p.merkleProof.root, p.merkleProof.siblings.map((s) => [s.hash, s.isLeft]),
    p.continuityProof.lowerEndpointDigest, p.continuityProof.roots];
}

export function revertReason(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; data?: string; message?: string };
  if (err.data && typeof err.data === 'string') {
    try { const d = nomenRead.interface.parseError(err.data); if (d) return `${d.name}(${d.args.map(String).join(',')})`; } catch { /* not ours */ }
  }
  return (err.reason ?? err.shortMessage ?? err.message ?? String(e)).slice(0, 200);
}

export function parseCreditEvents(receipt: ethers.TransactionReceipt): ethers.LogDescription[] {
  const out: ethers.LogDescription[] = [];
  for (const l of receipt.logs) {
    try { const d = nomenRead.interface.parseLog({ topics: [...l.topics], data: l.data }); if (d?.name === 'CreditEvent') out.push(d); } catch { /* other contract */ }
  }
  return out;
}

export async function walletBalance(): Promise<string> {
  return wallet ? ethers.formatEther(await cc.getBalance(wallet.address)) : 'n/a';
}
export function logWallet(): void {
  log(`creditcoin wallet ${wallet?.address ?? 'NONE (read-only)'} nomen ${config.nomenAddress} dryRun=${config.dryRun}`);
}
