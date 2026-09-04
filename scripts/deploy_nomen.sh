#!/usr/bin/env bash
# Deploy contracts/Nomen.sol to Creditcoin CC3 testnet from the Mac. No constructor args, no library linking.
# Uses `cast send --async` + raw receipt polling (Foundry 1.8.1's block watcher cannot parse CC3 blocks).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
RPC=${CREDITCOIN_RPC_URL:-https://rpc.cc3-testnet.creditcoin.network}
ADDR=$(cast wallet address --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY")
forge build >/dev/null
BYTECODE=$(python3 -c 'import json; print(json.load(open("out/Nomen.sol/Nomen.json"))["bytecode"]["object"])')
CODEHASH=$(cast keccak "$BYTECODE")
B0=$(cast balance "$ADDR" --rpc-url "$RPC")
TX=$(cast send --async --rpc-url "$RPC" --private-key "$CREDITCOIN_WALLET_PRIVATE_KEY" --create "$BYTECODE" | grep -o '0x[0-9a-fA-F]\{64\}' | head -1)
echo "deploy tx $TX"
for i in $(seq 1 60); do
  R=$(curl -s -m 20 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" "$RPC" | python3 -c '
import sys,json
r=json.load(sys.stdin).get("result")
if r: print(r["contractAddress"], int(r["gasUsed"],16), int(r["effectiveGasPrice"],16), int(r["blockNumber"],16), r["status"])')
  [ -n "$R" ] && break; sleep 3
done
[ -n "${R:-}" ] || { echo "receipt timeout"; exit 1; }
read -r NOMEN GAS PRICE BLOCK STATUS <<<"$R"
B1=$(cast balance "$ADDR" --rpc-url "$RPC")
echo "Nomen=$NOMEN gasUsed=$GAS gasPrice=$PRICE block=$BLOCK status=$STATUS"
echo "deployed code bytes: $(( ($(cast code "$NOMEN" --rpc-url "$RPC" | wc -c) - 3) / 2 ))"
python3 - "$NOMEN" "$TX" "$GAS" "$PRICE" "$BLOCK" "$STATUS" "$ADDR" "$CODEHASH" "$B0" "$B1" <<'PY'
import json,sys,datetime
a=sys.argv[1:]
d=dict(network="creditcoin-cc3-testnet",chainId=102031,rpc="https://rpc.cc3-testnet.creditcoin.network",
 contract="Nomen",address=a[0],tx=a[1],gasUsed=int(a[2]),gasPriceWei=int(a[3]),block=int(a[4]),status=a[5],
 deployer=a[6],creationBytecodeKeccak=a[7],balanceBeforeWei=a[8],balanceAfterWei=a[9],
 deployedAt=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
json.dump(d,open("deployments/cc3-testnet.json","w"),indent=2); print(json.dumps(d,indent=2))
PY
