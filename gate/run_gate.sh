#!/usr/bin/env bash
# nomen step-1 gate. Deploys gluwa's hello-bridge contracts UNCHANGED (ASCMinter + BridgeTestToken from
# attestcoin-protocol-examples, compiled with their foundry.toml), registers the pre-deployed Sepolia burner
# as emitter, executes ONE real Sepolia burn proof through ASCBase.execute via their unchanged
# custom_bridge:submit_query script, and records gas per execute + CTC balance before/after.
#
# Tooling note (measured 2026-09-04): `forge create` and non-async `cast send` on Foundry 1.8.1 broadcast fine
# but then crash in alloy's block watcher because CC3 blocks carry no `mixHash`. So every send here is
# `cast send --async` and receipts are polled over raw JSON-RPC.
# Runs on the Mac. Reads the key from attestcoin-protocol-examples/bridge/.env (never printed).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
EX=/Volumes/D/attestcoin-protocol-examples
OUT=/Volumes/D/nomen/gate
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$OUT/gate_run_$STAMP.log"
exec > >(tee -a "$LOG") 2>&1
cd "$EX"
set -a; . bridge/.env; set +a
RPC="$CREDITCOIN_RPC_URL"
ADDR=$(cast wallet address --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY")
BURNER=0x0F24FD9e0524BA53d3f0A4A40350Adf5370b4A53   # hello-bridge SOURCE_CHAIN_CONTRACT_ADDRESS (Sepolia)
BURN_TX=${1:-0x216a8c7289abdb279f0844605baeee7a490ffde1b203bf97383f5ed6ffb0e054}
# ASCMinter already deployed by the first (forge create) attempt of this script; reuse and record it.
MINTER=${MINTER:-0xE772DC00d9A580288fD10303632456690562a144}
MINTER_TX=${MINTER_TX:-0xd4238286f37d9464b2b42a2aa81d12211dba09f2e1c695c18e65d0e782561eb4}
B0=${GATE_B0:-10000000000000000000000}   # balance before the ASCMinter deploy (first run log)

bal(){ cast balance "$ADDR" --rpc-url "$RPC"; }
rpc(){ curl -s -m 20 -X POST -H 'content-type: application/json' --data "$1" "$RPC"; }
waitrcpt(){ # $1 txhash -> prints "gasUsed gasPrice cost block status contractAddress"
  for i in $(seq 1 60); do
    R=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$1\"]}" | python3 -c '
import sys,json
r=json.load(sys.stdin).get("result")
if r: g=int(r["gasUsed"],16); p=int(r["effectiveGasPrice"],16); print(g,p,g*p,int(r["blockNumber"],16),r["status"],r.get("contractAddress") or "-")')
    [ -n "$R" ] && { echo "$R"; return 0; }; sleep 3
  done; echo "RECEIPT TIMEOUT for $1" >&2; return 1
}
send(){ cast send --async --rpc-url "$RPC" --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY" "$@" | grep -o '0x[0-9a-fA-F]\{64\}' | head -1; }

echo "== gate start $STAMP deployer=$ADDR rpc=$RPC"
echo "balance_before_wei=$B0 (before ASCMinter deploy)"
echo "== 1. ASCMinter (unchanged) already deployed at $MINTER"
read -r MG MP MC MB MS _ < <(waitrcpt "$MINTER_TX")
echo "minter=$MINTER tx=$MINTER_TX gasUsed=$MG gasPrice=$MP cost_wei=$MC block=$MB status=$MS"

echo "== 2. deploy BridgeTestToken(minter) (unchanged bytecode from their forge build)"
BYTECODE=$(python3 -c 'import json; print(json.load(open("out/BridgeTestToken.sol/BridgeTestToken.json"))["bytecode"]["object"])')
CTOR=$(cast abi-encode "constructor(address)" "$MINTER" | sed 's/^0x//')
TOKEN_TX=$(send --create "${BYTECODE}${CTOR}")
read -r TG TP TC TB TS TOKEN < <(waitrcpt "$TOKEN_TX")
echo "token=$TOKEN tx=$TOKEN_TX gasUsed=$TG gasPrice=$TP cost_wei=$TC block=$TB status=$TS"
echo "token.owner=$(cast call --rpc-url "$RPC" "$TOKEN" "owner()(address)")"

echo "== 3. wrapOriginToken(burner, token)"
WRAP_TX=$(send "$MINTER" "wrapOriginToken(address,address)" "$BURNER" "$TOKEN")
read -r WG WP WC WB WS _ < <(waitrcpt "$WRAP_TX")
echo "wrap tx=$WRAP_TX gasUsed=$WG gasPrice=$WP cost_wei=$WC block=$WB status=$WS"
echo "wrappedTokens[burner]=$(cast call --rpc-url "$RPC" "$MINTER" "wrappedTokens(address)(address)" "$BURNER")"

echo "== 4. submit one real Sepolia burn proof via their custom_bridge:submit_query (unchanged script)"
B1=$(bal); echo "balance_before_execute_wei=$B1"
export ASC_CUSTOM_MINTER_CONTRACT_ADDRESS="$MINTER" ASC_CUSTOM_MINTABLE_TOKEN="$TOKEN" SOURCE_CHAIN_CUSTOM_CONTRACT_ADDRESS="$BURNER"
SUB="$OUT/submit_$STAMP.log"
T0=$(date +%s)
yarn -s custom_bridge:submit_query "$BURN_TX" 2>&1 | sed "s/$CREDITCOIN_WALLET_PRIVATE_KEY/<KEY>/g" | tee "$SUB"
T1=$(date +%s)
EXEC_TX=$(grep -o 'Proof submitted: *0x[0-9a-fA-F]\{64\}' "$SUB" | grep -o '0x[0-9a-fA-F]\{64\}' | tail -1)
[ -n "$EXEC_TX" ] || { echo "NO EXECUTE TX FOUND"; exit 3; }
read -r EG EP EC EB ES _ < <(waitrcpt "$EXEC_TX")
echo "execute tx=$EXEC_TX gasUsed=$EG gasPrice=$EP cost_wei=$EC block=$EB status=$ES wall_s=$((T1-T0))"
B2=$(bal); echo "balance_after_wei=$B2"
echo "btkt_minted_to_burner=$(cast call --rpc-url "$RPC" "$TOKEN" "balanceOf(address)(uint256)" 0x42a50d325fa26d49282cd4cece122b45e54927c3)"

python3 - "$OUT/gate_result_$STAMP.json" <<PY
import json,sys
r=dict(stamp="$STAMP",deployer="$ADDR",cc3_rpc="$RPC",
 faucet_amount_wei=$B0,balance_before_wei=$B0,balance_before_execute_wei=$B1,balance_after_wei=$B2,
 ascminter=dict(address="$MINTER",tx="$MINTER_TX",gas_used=$MG,gas_price_wei=$MP,cost_wei=$MC),
 bridgetesttoken=dict(address="$TOKEN",tx="$TOKEN_TX",gas_used=$TG,gas_price_wei=$TP,cost_wei=$TC),
 wrap_origin_token=dict(tx="$WRAP_TX",gas_used=$WG,gas_price_wei=$WP,cost_wei=$WC),
 execute=dict(tx="$EXEC_TX",gas_used=$EG,gas_price_wei=$EP,cost_wei=$EC,block=$EB,status="$ES",wall_seconds=$((T1-T0)),
   source_chain_key=1,source_tx="$BURN_TX",source_block=11627802,emitter="$BURNER"))
json.dump(r,open(sys.argv[1],"w"),indent=2); print(json.dumps(r,indent=2))
PY
echo "== gate done"
