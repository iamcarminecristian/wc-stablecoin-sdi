#!/usr/bin/env bash
# Verifica end-to-end del flusso di incasso: dal checkout WooCommerce al
# pagamento on-chain, fino alla transizione di stato dell'ordine.
#
# Copre i passi da 1 a 3 del flusso nominale del paragrafo 4.2 e serve a
# dimostrare RF-02, RF-03, RF-04 e RNF-03. Il rimborso e la fatturazione
# restano fuori: dipendono da servizi esterni e non sono riproducibili offline.
#
# Prerequisiti: make init eseguito, anvil attivo, contratti pubblicati.
# Uso: tools/e2e.sh <indirizzo token> <indirizzo contratto di inoltro>
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${1:?indirizzo del token mancante}"
FORWARDER="${2:?indirizzo del contratto di inoltro mancante}"

# Account di anvil: chiavi pubbliche e prive di qualunque valore.
MERCHANT=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
CLIENTE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
CLIENTE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

SECRET=$(grep -E '^WCSDI_SHARED_SECRET=' .env | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "WCSDI_SHARED_SECRET assente dal .env"; exit 1; }

wp() { docker compose run --rm -T wpcli "$@"; }

echo "== 1. configuro il gateway =="
wp option update wcsdi_watcher_secret "$SECRET" >/dev/null
wp option update woocommerce_wcsdi_eure_settings --format=json "$(cat <<JSON
{
  "enabled": "yes",
  "title": "Paga in EURe",
  "chain": "basesepolia",
  "receive_address": "$MERCHANT",
  "forwarder_address": "$FORWARDER",
  "confirmations": "2",
  "payment_window": "60"
}
JSON
)" >/dev/null
wp option update woocommerce_currency EUR >/dev/null
echo "   gateway configurato, incasso su $MERCHANT"

echo
echo "== 2. creo due ordini di pari importo =="
# Due ordini con lo stesso totale nella stessa finestra: e' il caso che senza
# il riferimento nell'evento sarebbe indistinguibile.
CREA='
$g = WC()->payment_gateways()->payment_gateways()["wcsdi_eure"];
$o = wc_create_order();
$o->add_product( null, 1 );
$o->set_currency("EUR");
$o->set_payment_method($g);
$o->set_total("49.90");
$o->save();
$r = $g->process_payment($o->get_id());
echo $o->get_id() . " " . $o->get_meta("_wcsdi_order_ref") . "\n";
'
ORD_A=$(wp eval "$CREA" | tr -d '\r')
ORD_B=$(wp eval "$CREA" | tr -d '\r')
ID_A=$(echo "$ORD_A" | awk '{print $1}'); REF_A=$(echo "$ORD_A" | awk '{print $2}')
ID_B=$(echo "$ORD_B" | awk '{print $1}'); REF_B=$(echo "$ORD_B" | awk '{print $2}')
echo "   ordine $ID_A -> ${REF_A:0:12}"
echo "   ordine $ID_B -> ${REF_B:0:12}"
[ "$REF_A" != "$REF_B" ] || { echo "FAIL: due ordini con lo stesso riferimento"; exit 1; }

echo
echo "== 3. avvio il servizio di rilevamento =="
RPC_URL=http://localhost:8545 \
FORWARDER_ADDRESS="$FORWARDER" \
CONFIRMATIONS=2 POLL_MS=1000 \
WCSDI_PLUGIN_URL=http://localhost:8080/?rest_route=/wcsdi/v1 \
WATCHER_STATE_FILE=/tmp/wcsdi-e2e-state.json \
AUTO_REDEEM=false \
node watcher/src/index.mjs > /tmp/wcsdi-e2e-watcher.log 2>&1 &
WATCHER=$!
trap 'kill $WATCHER 2>/dev/null || true' EXIT
sleep 3

echo
echo "== 4. il cliente paga i due ordini =="
node tools/local-chain/e2e-pay.mjs "$TOKEN" "$FORWARDER" "$CLIENTE_KEY" "$REF_A" "$REF_B"

# Le conferme maturano solo con nuovi blocchi.
for _ in 1 2 3 4; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' \
    http://localhost:8545 >/dev/null
  sleep 1
done
sleep 4

echo
echo "== 5. verifico gli ordini =="
STATO_A=$(wp eval "echo wc_get_order($ID_A)->get_status();" | tr -d '\r')
STATO_B=$(wp eval "echo wc_get_order($ID_B)->get_status();" | tr -d '\r')
PAID_A=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_paid_total');" | tr -d '\r')
PAID_B=$(wp eval "echo wc_get_order($ID_B)->get_meta('_wcsdi_paid_total');" | tr -d '\r')

falliti=0
verifica() { if [ "$2" = "$3" ]; then echo "  OK   $1"; else echo "  FAIL $1 (atteso '$3', ottenuto '$2')"; falliti=$((falliti+1)); fi; }
# WooCommerce porta direttamente a completed gli ordini senza righe da
# spedire: entrambi gli stati testimoniano che il pagamento e' stato accolto.
pagato() { case "$2" in processing|completed) echo "  OK   $1 ($2)";; *) echo "  FAIL $1 (stato '$2')"; falliti=$((falliti+1));; esac; }
# wc_format_decimal normalizza gli zeri finali: il confronto va fatto sul valore.
importo_uguale() { if awk -v a="$2" -v b="$3" 'BEGIN{exit !(a==b)}'; then echo "  OK   $1"; else echo "  FAIL $1 (atteso '$3', ottenuto '$2')"; falliti=$((falliti+1)); fi; }

pagato "ordine $ID_A risulta pagato" "$STATO_A"
pagato "ordine $ID_B risulta pagato" "$STATO_B"
importo_uguale "ordine $ID_A incassa il dovuto" "$PAID_A" "49.90"
importo_uguale "ordine $ID_B incassa il dovuto" "$PAID_B" "49.90"

echo
echo "== 6. verifico l'idempotenza =="
# La stessa notifica ripetuta non deve produrre un secondo incasso (RNF-03).
TX=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_tx_hash');" | tr -d '\r')
RISP=$(curl -s -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_A\",\"tx_hash\":\"$TX\",\"log_index\":1,\"amount\":\"49.90\"}")
echo "$RISP" | grep -q '"duplicate"' \
  && echo "  OK   la notifica ripetuta è riconosciuta come duplicata" \
  || { echo "  FAIL notifica ripetuta non riconosciuta: $RISP"; falliti=$((falliti+1)); }

echo
echo "== 7. verifico il rifiuto senza segreto =="
CODICE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' \
  --data "{\"order_ref\":\"$REF_A\",\"tx_hash\":\"0x00\",\"log_index\":0,\"amount\":\"1\"}")
verifica "notifica senza segreto respinta" "$CODICE" "401"

echo
echo "--- log del servizio ---"
cat /tmp/wcsdi-e2e-watcher.log

echo
if [ "$falliti" -eq 0 ]; then echo "Tutte le verifiche superate."; else echo "$falliti verifiche fallite."; fi
exit "$falliti"
