# nomen

*In Roman bookkeeping a nomen was a debt entry: a creditor's claim, on record.*

Portable, proven credit history. Any Ethereum address's lending history on **Aave v3**, **Morpho Blue** and **Spark** is turned into records on **Creditcoin**, and every record exists only because the Attestcoin native query verifier proved that the Ethereum mainnet transaction which produced it was included in an attested block. No oracle, no indexer's word, no self-report. From those records a deterministic score is computed on-chain, readable by any lender on Creditcoin. A borrower can submit their own history; a recorder also runs the whole market so the score has a population behind it.

Built for BUIDL CTC 2026 Fall (RWA track). Everything below is measured; anything unmeasured says so.

## Status, 2026-09-04

| | |
|---|---|
| Contract | `Nomen` at [`0x0c019ee3298111b3b067ae1ba93f73d93ee5230e`](https://creditcoin-testnet.blockscout.com/address/0x0c019ee3298111b3b067ae1ba93f73d93ee5230e) on Creditcoin CC3 testnet (chainId 102031) |
| Deploy tx | `0x1792c8bce4343c362cc0253276293d67fa695dd0a564d7121291fae4b1530250`, 2,063,812 gas |
| Tests | 24 Foundry tests, all passing, five of them against real prover responses from Ethereum mainnet |
| Live records | 5 credit events proven and recorded: Aave v3 Borrow, Morpho Blue Borrow, Morpho Blue Repay, Spark Borrow, Aave v3 LiquidationCall. Five borrowers scored. |
| First CreditEvent on CC3 | `0xd950b51b24f9feaf364848418d02e3f68eb0e006844d2d5e53f8e5cf0755d949` (Spark Borrow, 2.9M USDS, Ethereum block 25,903,309) |
| Recorder | not yet running (step 3) |

## How a record comes to exist

1. A Borrow, Repay or Liquidation happens on Ethereum mainnet in one of three pools: Aave v3 Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, Spark Pool `0xC13e21B648A5Ee794902342038FF3aDAB66BE987`.
2. Creditcoin attests the Ethereum block (measured lag ~23–40 blocks behind the live head).
3. The prover service returns the encoded transaction plus receipt, a Merkle inclusion proof and a continuity proof: `GET https://prover.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/3/<txhash>`.
4. Anyone calls `Nomen.record(kind, 3, height, txBytes, root, siblings, lowerEndpointDigest, roots)`.
5. `record` reuses `ASCBase`'s query id, replay check and `_verifyProof` verbatim; the native verifier precompile at `0xFD2` checks inclusion and continuity. Nothing is trusted from the caller.
6. The contract decodes the proven receipt with `EvmV1Decoder`, keeps only logs whose emitter is one of the three pools and whose topic0 is one of the six credit events, checks the exact data length for that layout, and updates the borrower's `Record`. One `CreditEvent` per credit event found. A receipt with none of the asserted kind reverts with `NoCreditEvent`; a zero amount is never recorded; a status-0 receipt is rejected; a source chain other than Ethereum mainnet (chainKey 3) is rejected.

There is no owner, no admin, no pause and no way to edit or delete a record. The proof surface is transaction inclusion only; there is no state proof, so everything the contract knows comes from decoded receipt logs.

Borrower per event: Aave/Spark `onBehalfOf` (Borrow), `user` (Repay, LiquidationCall); Morpho `onBehalf` (Borrow, Repay), `borrower` (Liquidate). Amount: Aave `amount`, `amount`, `debtToCover`; Morpho `assets`, `assets`, `repaidAssets`. Event layouts were verified against the protocols' own source and are pinned by commit in [docs/reference/SOURCES.md](docs/reference/SOURCES.md).

## The score

`score(address) → (uint16 value, uint8 grade)` is a pure function of the proven record. It is not a credit model; it is a demonstration that one can be computed on-chain from proven inputs.

```
no history                         -> (0, 'N')
base                                  500
+ min(200, repays * 10)
+ 50 if borrows > 0 and liquidations == 0
- 150 per liquidation, decaying linearly to 0 over 2,628,000 Ethereum blocks (~1 year)
     since the last liquidation, measured against the attested Ethereum head read from the
     ChainInfo precompile 0xFD3 (falls back to the borrower's last proven block)
clamp 0..1000
grade: A >= 700, B >= 600, C >= 500, D >= 350, else E
```

Amounts in `Record` are raw token units summed across assets. USD notional is an off-chain figure and will be labelled with its method when the recorder ships it.

## Measured numbers

### Gate: gluwa's hello-bridge contracts, deployed unchanged, one real proof

Before writing any contract of ours, `ASCMinter.sol` and `BridgeTestToken.sol` from `gluwa/attestcoin-protocol-examples` were deployed unchanged, the pre-deployed Sepolia burner was registered as emitter, and one real Sepolia burn was proven through `execute` with their unchanged `custom_bridge:submit_query` script ([gate/run_gate.sh](gate/run_gate.sh), [gate/gate_result_20260904T182424Z.json](gate/gate_result_20260904T182424Z.json)).

| | gas | CTC |
|---|---|---|
| Faucet, one `/faucet` claim in Discord | | **10,000 tCTC** (docs say 100; daily allowance beyond one claim unmeasured) |
| ASCMinter deploy | 1,391,802 | 0.0020877 (forge's 1.5 gwei) |
| BridgeTestToken deploy | 817,689 | 0.0004088 |
| wrapOriginToken | 148,876 | 0.0000744 |
| **`execute`, one Sepolia burn proof** (1,921 B txBytes, 7 siblings, 99 continuity roots) | **239,050** | **0.000119525** at 0.5 gwei, 14 s wall |
| Balance before / after gate | | 10,000.0000 / 9,999.9973 |

### Nomen on CC3, proofs fetched seconds before submission

| protocol | kind | txBytes | continuity roots | gas | CTC | CC3 tx |
|---|---|---|---|---|---|---|
| Morpho Blue | Borrow | 2,976 B | 9 | 214,270 | 0.000107 | `0x24b107df…` |
| Aave v3 | Borrow | 3,328 B | 58 | 241,150 | 0.000121 | `0x1fd7a8d2…` |
| Morpho Blue | Repay | 5,376 B | 31 | 261,452 | 0.000131 | `0x5c5daab8…` |
| Spark | Borrow | 3,328 B | 92 | 308,031 | 0.000154 | `0xd950b51b…` |
| Aave v3 | LiquidationCall | 11,488 B | 60 | 414,471 | 0.000207 | `0x562966c8…` |

Full rows with borrowers, amounts and query ids: [deployments/live_records.json](deployments/live_records.json). Gas grows with receipt size and with the number of continuity roots, roughly 1,100 gas per root.

At 0.0001–0.0002 CTC per record and 10,000 tCTC from one faucet claim, gas does not cap the headline; attestation lag, prover availability and the Ethereum log source do. Total spent so far across 13 transactions: 0.00483 CTC.

### Cost of a stale proof

Three proofs fetched at 13:04 UTC and submitted at 18:38 UTC reverted in the verifier: 210,630, 235,270 and 324,870 gas (0.000105–0.000162 CTC each). Re-fetched seconds before submission, the same three transactions recorded fine. See finding 1.

## Findings: documentation versus what the chain does

1. **Prover responses go stale.** The receipt, Merkle root and siblings are stable, but `continuityProof.roots` changes as attestations roll into 100-block checkpoints (8 roots at capture, 58 five hours later for the same tx). A proof is valid only against the current attestation state. Fetch it right before submitting; on revert, re-fetch once. The docs do not mention this.
2. **`EvmV1Decoder` needs no linking** in `@gluwa/asc-contracts@0.2.1`: every function is `internal`, `forge build` reports zero link references, and the pre-deployed hello-bridge minter's bytecode references neither documented library address. The 57-byte deployment at `0x04B9ae85…` (examples `.env`) is the stub an all-internal library leaves behind; `0x731c345d…` (docs environments page) is a 9,598-byte build of something else. The tutorial's `--libraries` flag is a no-op.
3. **Foundry 1.8.1 cannot confirm transactions on CC3.** `forge create` and non-async `cast send` broadcast correctly, then crash in alloy's block watcher because CC3 blocks carry no `mixHash`. The tutorial's `forge create` therefore "fails" after a successful deploy. Workaround used throughout: `cast send --async` plus raw `eth_getTransactionReceipt` polling ([scripts/deploy_nomen.sh](scripts/deploy_nomen.sh)).
4. **`ASCBase.execute` cannot enforce the source chain.** It is non-virtual and its hook receives only `(action, queryId, encodedTransaction)`, never the chain key or block height. `Nomen.record` has the same signature as `execute`, calls the same internal `_computeQueryId` / `_verifyProof` / `processedQueries`, and adds the chainKey check and the proven height. The inherited `execute` reverts with `UseRecord()` so it cannot be used to bypass the check.
5. **Both prover hosts work and behave identically**: `prover.cc3-testnet.creditcoin.network` (examples `.env`) and `proof-gen-api.cc3-testnet.creditcoin.network` (docs). Mainnet has a 32-block reorg window: a transaction younger than that returns `BlockNotOnSourceChain`, retriable. The prover marks proofs `cached: true` on first request, so it pre-indexes attested blocks.
6. **The tutorial's example Sepolia hash** `0x87c97c77…` is unknown to the prover (`TxHashNotFound`). hello-bridge has no deploy step; the deployable copy of the same contracts is `custom-contracts-bridging`.
7. **Faucet**: pays 10,000 tCTC, not the documented 100, from the substrate side (no EVM transaction appears for it; nonce stays 0).
8. **Ethereum log source**: `eth.drpc.org` serves `eth_getLogs` over 7,200-block ranges without a token but intermittently answers `Can't route your request to suitable provider` (code 12) and rejects Python's default user agent with 403. 1,200-block chunks with retry and backoff worked. publicnode, 1rpc, flashbots and cloudflare refuse or cap the ranges.

## Compound v3 is out, and why

Compound v3 (Comet) emits `Supply` and `Withdraw`; whether a withdraw is a borrow or a supply is a repay depends on the sign of the account's base balance at that moment, which is state. Attestcoin proves transaction inclusion, not state, so a Comet receipt alone cannot tell a borrow from a withdrawal. Rather than guess, Compound is excluded from v1.

## Layout

```
contracts/Nomen.sol            the contract
test/Nomen.t.sol               24 tests; 0xFD2 and 0xFD3 mocked, real prover fixtures for decoding
test/fixtures/*.json           raw prover responses (chainKey 3) + expected.json read independently from the receipts
scripts/deploy_nomen.sh        deploy to CC3 (cast send --async + receipt polling)
scripts/record_fixture.mjs     submit one prover response via record() and print gas + CreditEvent
gate/                          the step-1 gate script and its results
deployments/                   cc3-testnet.json (deploy), live_records.json (every live record() so far)
docs/reference/SOURCES.md      event declarations pinned to aave-v3-origin and morpho-blue commits
```

```bash
npm install && forge install && forge test
```

Deploy and record need `CREDITCOIN_WALLET_PRIVATE_KEY` in `.env` (a fresh testnet key; never anything of value).

## Prior work

This repository is new, in-window work for BUIDL CTC 2026 Fall. The author's other measurement projects, none of whose code is used here: [overhang](https://github.com/seekdaseek/overhang) (Solana lending collateral marked above its exit price), [datum](https://github.com/seekdaseek/datum) (zero-knowledge solvency attestation on Midnight), [agentfeed](https://github.com/seekdaseek/agentfeed) (paid market data for agents over x402). Contract pattern learned from `gluwa/attestcoin-protocol-examples`; the only code taken from there is the unchanged hello-bridge deployment in the gate.

## License

MIT
