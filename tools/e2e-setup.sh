#!/usr/bin/env bash
# Prepara la chain locale e lancia la verifica end-to-end.
# Pubblica il token di prova e il contratto di inoltro, poi passa i due
# indirizzi a tools/e2e.sh. Invocato da `make e2e`.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d anvil >/dev/null
echo "[e2e] pubblico il token di prova e il contratto di inoltro..."

( cd tools/local-chain && npm install --silent && node deploy.mjs >/dev/null )
TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync('tools/local-chain/deployment.json')).token)")"

MERCHANT=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
( cd contracts && npm install --silent && npm run compile >/dev/null \
  && RPC_URL=http://localhost:8545 TOKEN_ADDRESS="$TOKEN" WATCH_ADDRESS="$MERCHANT" node deploy.mjs >/dev/null )
FORWARDER="$(node -e "console.log(JSON.parse(require('fs').readFileSync('contracts/build/deployment.json')).forwarder)")"

echo "[e2e] token $TOKEN"
echo "[e2e] inoltro $FORWARDER"
echo

rm -f /tmp/wcsdi-e2e-state.json
exec ./tools/e2e.sh "$TOKEN" "$FORWARDER"
