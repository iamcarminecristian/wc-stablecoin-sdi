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

# La fatturazione si prova solo se il sandbox del fornitore e' configurato:
# senza credenziali il resto del flusso resta comunque verificabile offline.
SDI_TOKEN=$(grep -E '^OPENAPI_SDI_TOKEN=' .env | cut -d= -f2-)
SDI_BASE=$(grep -E '^OPENAPI_SDI_BASE_URL=' .env | cut -d= -f2-)
SDI_FISCAL=$(grep -E '^OPENAPI_FISCAL_ID=' .env | cut -d= -f2-)
FATTURAZIONE=0
[ -n "$SDI_TOKEN" ] && [ -n "$SDI_FISCAL" ] && FATTURAZIONE=1

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
  "payment_window": "60",
  "openapi_base_url": "${SDI_BASE}",
  "openapi_token": "${SDI_TOKEN}",
  "cedente_cf": "${SDI_FISCAL}",
  "cedente_denominazione": "Carmine Cristian Cruoglio",
  "cedente_indirizzo": "Via di Test, 1",
  "cedente_cap": "00100",
  "cedente_comune": "Roma",
  "cedente_provincia": "RM",
  "cedente_regime": "RF01"
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
$o->set_currency("EUR");
$o->set_payment_method($g);
$o->set_address( array(
  "first_name" => "Mario", "last_name" => "Rossi",
  "address_1" => "Via del Cliente, 2", "postcode" => "00100",
  "city" => "Roma", "state" => "RM", "country" => "IT",
), "billing" );
$o->update_meta_data("_wcsdi_codice_fiscale", "RSSMRA80A01H501U");
$item = new WC_Order_Item_Fee();
$item->set_name("Servizio di prova");
$item->set_total(40.90);
$item->set_total_tax(9.00);
$o->add_item($item);
$o->set_total("49.90");
$o->save();
$r = $g->process_payment($o->get_id());
// process_payment lavora su una propria istanza: il riferimento va
// riletto da una lettura fresca, non dall oggetto creato qui.
$fresco = wc_get_order($o->get_id());
echo $o->get_id() . " " . $fresco->get_meta("_wcsdi_order_ref") . "
";
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
if [ "$FATTURAZIONE" = "1" ]; then
  echo "== 8. verifico la fatturazione elettronica =="
  # Action Scheduler non gira da solo in un ambiente senza traffico: la coda
  # va drenata a mano, ed e' anche il modo piu' onesto di provarla.
  # Il runner via CLI non trova il gruppo in un'installazione senza traffico:
  # si esegue direttamente la coda dall'interno di WordPress.
  wp eval 'ActionScheduler::runner()->run();' >/dev/null 2>&1 || true
  sleep 2
  wp eval 'ActionScheduler::runner()->run();' >/dev/null 2>&1 || true

  UUID_A=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_fattura_uuid');" | tr -d '\r')
  NUM_A=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_fattura_numero');" | tr -d '\r')
  STATO_F=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_fattura_stato');" | tr -d '\r')
  ERR_A=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_fattura_errore');" | tr -d '\r')

  if [ -n "$UUID_A" ]; then
    echo "  OK   fattura trasmessa (numero $NUM_A, stato $STATO_F)"
    echo "       identificativo $UUID_A"
  else
    echo "  FAIL fattura non trasmessa per l'ordine $ID_A"
    [ -n "$ERR_A" ] && echo "       errore: $ERR_A"
    falliti=$((falliti+1))
  fi

  # Il numero progressivo non deve essere consumato due volte, altrimenti la
  # serie avrebbe duplicati o buchi.
  NUM_B=$(wp eval "echo wc_get_order($ID_B)->get_meta('_wcsdi_fattura_numero');" | tr -d '\r')
  if [ -n "$NUM_A" ] && [ -n "$NUM_B" ] && [ "$NUM_A" != "$NUM_B" ]; then
    echo "  OK   i due ordini hanno numeri di fattura distinti ($NUM_A, $NUM_B)"
  else
    echo "  FAIL numerazione non distinta (A='$NUM_A', B='$NUM_B')"
    falliti=$((falliti+1))
  fi

  # Riaccodare non deve produrre una seconda trasmissione (RNF-03).
  wp eval "WCSDI_Fatturazione::accoda($ID_A);" >/dev/null 2>&1 || true
  wp eval 'ActionScheduler::runner()->run();' >/dev/null 2>&1 || true
  UUID_A2=$(wp eval "echo wc_get_order($ID_A)->get_meta('_wcsdi_fattura_uuid');" | tr -d '\r')
  verifica "un secondo accodamento non ritrasmette" "$UUID_A2" "$UUID_A"
  echo
fi

echo "--- log del servizio ---"
cat /tmp/wcsdi-e2e-watcher.log

echo
if [ "$falliti" -eq 0 ]; then echo "Tutte le verifiche superate."; else echo "$falliti verifiche fallite."; fi
exit "$falliti"
