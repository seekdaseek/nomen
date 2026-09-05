#!/usr/bin/env bash
# Deploy / update the recorder on the VPS (run from the Mac). First run clones the public repo into /opt/nomen and
# copies the Mac's .env (the fresh testnet key) over scp; later runs git pull + npm ci and cycle PM2.
# PM2 rule on this box: cycle with delete + start + save so .env changes are picked up (an in-place reload keeps stale env).
set -euo pipefail
H=solwatch
APP=/opt/nomen
PORT=${NOMEN_PORT:-3023}
cd "$(dirname "$0")/.."
if ! ssh -o BatchMode=yes $H "test -d $APP/.git"; then
  echo "== first deploy: clone"
  ssh -o BatchMode=yes $H "git clone -q https://github.com/seekdaseek/nomen.git $APP"
  scp -q ./.env $H:$APP/.env
  ssh -o BatchMode=yes $H "chmod 600 $APP/.env && (grep -q '^NOMEN_PORT=' $APP/.env || echo 'NOMEN_PORT=$PORT' >> $APP/.env); awk -F= '{print \$1, length(\$2)}' $APP/.env"
fi
echo "== pull + install"
ssh -o BatchMode=yes $H "cd $APP && git pull -q --ff-only && npm ci --omit=dev --no-audit --no-fund --silent && node -v && git log --oneline | head -1"
echo "== port check"
if ssh -o BatchMode=yes $H "ss -ltnH | awk '{print \$4}' | grep -q ':$PORT\$'" && ! ssh -o BatchMode=yes $H "pm2 describe nomen >/dev/null 2>&1"; then
  echo "port $PORT is taken by something that is not pm2 nomen; aborting"; exit 1
fi
echo "== pm2 cycle"
ssh -o BatchMode=yes $H "cd $APP && (pm2 delete nomen >/dev/null 2>&1 || true) && pm2 start recorder/start.mjs --name nomen --node-args='--no-warnings' --time && pm2 save >/dev/null"
sleep 8
ssh -o BatchMode=yes $H "pm2 describe nomen | grep -E 'status|script path|uptime|restarts' ; pm2 logs nomen --lines 15 --nostream --no-color | tail -15; curl -s -m 10 localhost:$PORT/health"
