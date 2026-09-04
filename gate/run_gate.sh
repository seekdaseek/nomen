#!/usr/bin/env bash
# nomen step-1 gate. Deploys gluwa's hello-bridge contracts UNCHANGED (ASCMinter + BridgeTestToken from
# attestcoin-protocol-examples), registers the pre-deployed Sepolia burner as emitter, executes ONE real
# Sepolia burn proof through ASCBase.execute, and records gas per execute + CTC balance before/after.
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
LIB=node_modules/@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol:EvmV1Decoder:$EVM_V1_DECODER_LIBRARY_ADDRESS

bal(){ cast balance "$ADDR" --rpc-url "$RPC"; }
lastjson(){ grep '^{' | tail -1; }
deployed(){ python3 -c 'import sys,json
d=json.load(sys.stdin)
if isinstance(d,dict) and "data" in d: d=d["data"]
if isinstance(d,list): d=d[0]
print(d["deployedTo"], d["transactionHash"])'; }
rgas(){ cast receipt "$1" --rpc-url "$RPC" --json | python3 -c 'import sys,json
r=json.load(sys.stdin); g=int(r["gasUsed"],16); p=int(r["effectiveGasPrice"],16); print(g, p, g*p, int(r["blockNumber"],16), r["status"])'; }

echo "== gate start $STAMP deployer=$ADDR rpc=$RPC"
B0=$(bal); echo "balance_before_wei=$B0"

echo "== 1. deploy ASCMinter (unchanged)"
read -r MINTER MINTER_TX < <(forge create --broadcast --json --rpc-url "$RPC" --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY" --libraries "$LIB" bridge/contracts/sol/ASCMinter.sol:ASCMinter | lastjson | deployed)
read -r MG MP MC MB MS < <(rgas "$MINTER_TX")
echo "minter=$MINTER tx=$MINTER_TX gasUsed=$MG gasPrice=$MP cost_wei=$MC block=$MB status=$MS"

echo "== 2. deploy BridgeTestToken(minter) (unchanged)"
read -r TOKEN TOKEN_TX < <(forge create --broadcast --json --rpc-url "$RPC" --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY" bridge/contracts/sol/BridgeTestToken.sol:BridgeTestToken --constructor-args "$MINTER" | lastjson | deployed)
read -r TG TP TC TB TS < <(rgas "$TOKEN_TX")
echo "token=$TOKEN tx=$TOKEN_TX gasUsed=$TG gasPrice=$TP cost_wei=$TC block=$TB status=$TS"

echo "== 3. wrapOriginToken(burner, token)"
WRAP_TX=$(cast send --json --rpc-url "$RPC" --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY" "$MINTER" "wrapOriginToken(address,address)" "$BURNER" "$TOKEN" | lastjson | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d.get("data",d); print(d["transactionHash"])')
read -r WG WP WC WB WS < <(rgas "$WRAP_TX")
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
read -r EG EP EC EB ES < <(rgas "$EXEC_TX")
echo "execute tx=$EXEC_TX gasUsed=$EG gasPrice=$EP cost_wei=$EC block=$EB status=$ES wall_s=$((T1-T0))"
B2=$(bal); echo "balance_after_wei=$B2"
echo "btkt_minted_to_burner=$(cast call --rpc-url "$RPC" "$TOKEN" "balanceOf(address)(uint256)" 0x42a50d325fa26d49282cd4cece122b45e54927c3)"

python3 - "$OUT/gate_result_$STAMP.json" <<PY
import json,sys
r=dict(stamp="$STAMP",deployer="$ADDR",cc3_rpc="$RPC",gas_price_wei=$EP,
 balance_before_wei=$B0,balance_before_execute_wei=$B1,balance_after_wei=$B2,
 ascminter=dict(address="$MINTER",tx="$MINTER_TX",gas_used=$MG,cost_wei=$MC),
 bridgetesttoken=dict(address="$TOKEN",tx="$TOKEN_TX",gas_used=$TG,cost_wei=$TC),
 wrap_origin_token=dict(tx="$WRAP_TX",gas_used=$WG,cost_wei=$WC),
 execute=dict(tx="$EXEC_TX",gas_used=$EG,cost_wei=$EC,block=$EB,status="$ES",wall_seconds=$((T1-T0)),
   source_chain_key=1,source_tx="$BURN_TX",source_block=11627802,emitter="$BURNER"))
json.dump(r,open(sys.argv[1],"w"),indent=2); print(json.dumps(r,indent=2))
PY
echo "== gate done"
