#!/usr/bin/env bash
# Verifica end-to-end del flusso di incasso: dal checkout WooCommerce al
# pagamento on-chain, fino alla transizione di stato dell'ordine.
#
# Copre i passi da 1 a 3 del flusso nominale del paragrafo 4.2 e serve a
# dimostrare RF-02, RF-03, RF-04 e RNF-03. Il rimborso resta fuori: dipende
# da servizi esterni e non e' riproducibile offline; la fatturazione e la
# nota di credito si provano solo se il sandbox del fornitore e' configurato
# nel .env.
#
# Verifica inoltre l'endpoint di configurazione REST e la sua autenticazione,
# il battito di vita del servizio di rilevamento, la concorrenza sul
# numeratore delle fatture, la validazione dell'input sull'endpoint di
# notifica del pagamento (riferimento malformato, importo nullo, rete
# diversa da quella attesa), il blocco per ordine su notifiche parallele
# identiche, la ripartenza del servizio con un evento in attesa dopo un
# riavvio, e la composizione della fattura per il cessionario estero e per
# il cliente italiano privo di dati fiscali.
#
# Il negozio configurato da questo script serve anche le campagne di misura
# su Base Sepolia: la configurazione precedente viene salvata all'avvio e
# ripristinata all'uscita, insieme all'arresto del servizio di rilevamento.
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

falliti=0
verifica() { if [ "$2" = "$3" ]; then echo "  OK   $1"; else echo "  FAIL $1 (atteso '$3', ottenuto '$2')"; falliti=$((falliti+1)); fi; }
# WooCommerce porta direttamente a completed gli ordini senza righe da
# spedire: entrambi gli stati testimoniano che il pagamento e' stato accolto.
pagato() { case "$2" in processing|completed) echo "  OK   $1 ($2)";; *) echo "  FAIL $1 (stato '$2')"; falliti=$((falliti+1));; esac; }
# wc_format_decimal normalizza gli zeri finali: il confronto va fatto sul valore.
importo_uguale() { if awk -v a="$2" -v b="$3" 'BEGIN{exit !(a==b)}'; then echo "  OK   $1"; else echo "  FAIL $1 (atteso '$3', ottenuto '$2')"; falliti=$((falliti+1)); fi; }
# Attende la riga "Watcher avviato" nel log del servizio, invece di un tempo
# fisso: le verifiche di avvio contattano il plugin e la chain, e con
# TOKEN_ADDRESS impostato tentano anche la lettura del validatore del token,
# che sulla chain locale non esiste e fa perdere qualche secondo in piu' nel
# gestire il fallimento. Un'attesa fissa troppo breve fa partire il pagamento
# prima che il servizio abbia preso la testa della catena come riferimento,
# e i pagamenti risulterebbero non visti per sempre.
attendi_watcher() {
  local log="$1" limite="$2" trascorsi=0
  while [ "$trascorsi" -lt "$limite" ]; do
    grep -q "Watcher avviato" "$log" 2>/dev/null && return 0
    sleep 1
    trascorsi=$((trascorsi+1))
  done
  grep -q "Watcher avviato" "$log" 2>/dev/null
}

# Il negozio e' anche quello delle campagne su Base Sepolia: la
# configurazione precedente si salva qui e si ripristina all'uscita, insieme
# all'arresto del servizio di rilevamento (che puo' essere stato riavviato
# nel frattempo, quindi il trap legge WATCHER al momento dell'uscita, non
# al momento in cui e' stato scritto).
# L'uscita di wp-cli via docker porta i ritorni a capo di Windows: senza
# toglierli il JSON non viene riaccettato in scrittura e il ripristino
# fallirebbe in silenzio, lasciando il negozio configurato su anvil.
CONFIG_ORIGINALE="$(wp option get woocommerce_wcsdi_eure_settings --format=json 2>/dev/null | tr -d '\r')" || CONFIG_ORIGINALE=''
WATCHER=""
pulisci() {
  kill "$WATCHER" 2>/dev/null || true
  if [ -n "$CONFIG_ORIGINALE" ]; then
    if wp option update woocommerce_wcsdi_eure_settings --format=json "$CONFIG_ORIGINALE" >/dev/null 2>&1; then
      echo "   configurazione del gateway ripristinata"
    else
      echo "   ATTENZIONE: configurazione del gateway NON ripristinata, reimpostarla a mano"
    fi
  fi
  # La compilazione di e2e-setup riscrive l'artefatto del contratto con una
  # impronta di metadati diversa: l'artefatto tracciato e' quello del
  # contratto pubblicato su Base Sepolia e non deve cambiare.
  git checkout -- contracts/build/OrderForwarder.json 2>/dev/null || true
}
trap pulisci EXIT

echo "== 1. configuro il gateway =="
wp option update wcsdi_watcher_secret "$SECRET" >/dev/null
wp option update woocommerce_wcsdi_eure_settings --format=json "$(cat <<JSON
{
  "enabled": "yes",
  "title": "Paga in EURe",
  "chain": "anvil",
  "token_address": "$TOKEN",
  "receive_address": "$MERCHANT",
  "forwarder_address": "$FORWARDER",
  "finality_mode": "confirmations",
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
// set_total_tax da solo non sopravvive al salvataggio: senza una riga in
// taxes il data store lo azzera alla rilettura e la fattura verrebbe
// composta con IVA zero. Il rate_id non corrisponde a una tariffa reale
// in anagrafica: in tal caso il composer ricava comunque la aliquota dal
// rapporto imposta su imponibile. (Niente apostrofi qui: il blocco vive
// dentro una stringa bash a virgolette singole.)
$item->set_taxes( array( "total" => array( 1 => "9.00" ) ) );
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
CHAIN_ID=31337 \
TOKEN_ADDRESS="$TOKEN" \
FINALITY_MODE=confirmations \
CONFIRMATIONS=2 POLL_MS=1000 \
WCSDI_PLUGIN_URL=http://localhost:8080/?rest_route=/wcsdi/v1 \
WATCHER_STATE_FILE=/tmp/wcsdi-e2e-state.json \
AUTO_REDEEM=false \
node watcher/src/index.mjs > /tmp/wcsdi-e2e-watcher.log 2>&1 &
WATCHER=$!
# All'avvio il servizio legge GET /config e si ferma se la rete o il
# contratto di inoltro non coincidono con i propri: la riga "Watcher
# avviato" compare solo se le verifiche di avvio sono passate.
if attendi_watcher /tmp/wcsdi-e2e-watcher.log 20; then
  echo "  OK   il servizio di rilevamento e' partito"
else
  echo "  FAIL il servizio di rilevamento non e' partito"
  cat /tmp/wcsdi-e2e-watcher.log
  falliti=$((falliti+1))
fi

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
echo "== 7b. verifico la ricerca dell'ordine oltre i cinque piu' recenti =="
# Il data store classico ignora la meta_query di wc_get_orders: senza il
# filtro del plugin la ricerca restituiva i cinque ordini piu' recenti e un
# pagamento veniva trovato solo se il suo ordine era fra quelli. Si creano
# sei ordini e si notifica il primo, che e' il sesto piu' recente.
ORD_V=$(wp eval "$CREA" | tr -d '\r')
ID_V=$(echo "$ORD_V" | awk '{print $1}'); REF_V=$(echo "$ORD_V" | awk '{print $2}')
for _ in 1 2 3 4 5; do wp eval "$CREA" >/dev/null 2>&1; done
TX_V="0x$(printf '55%.0s' {1..32})"
RISP_V=$(curl -s -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_V\",\"tx_hash\":\"$TX_V\",\"log_index\":0,\"amount\":\"49.90\",\"chain_id\":31337,\"block_number\":1}")
echo "$RISP_V" | grep -q '"accepted"' \
  && echo "  OK   l'ordine $ID_V, sesto piu' recente, viene trovato dal riferimento" \
  || { echo "  FAIL ordine $ID_V non trovato dal riferimento: $RISP_V"; falliti=$((falliti+1)); }

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

echo "== 9. verifico la scadenza della finestra di pagamento =="
# Un ordine mai pagato deve chiudersi quando la finestra e' passata.
SCAD=$(wp eval '
$g = WC()->payment_gateways()->payment_gateways()["wcsdi_eure"];
$o = wc_create_order();
$o->set_currency("EUR");
$o->set_payment_method($g);
$item = new WC_Order_Item_Fee();
$item->set_name("Ordine mai pagato"); $item->set_total(10.00); $item->set_total_tax(2.20);
$o->add_item($item); $o->set_total("12.20"); $o->save();
$g->process_payment($o->get_id());
echo $o->get_id();
' | tr -d '\r')
wp eval "WCSDI_Scadenza::verifica($SCAD);" >/dev/null 2>&1 || true
STATO_SCAD=$(wp eval "echo wc_get_order($SCAD)->get_status();" | tr -d '\r')
verifica "ordine non pagato chiuso alla scadenza" "$STATO_SCAD" "failed"

# Su un ordine gia' pagato la scadenza non deve avere alcun effetto.
wp eval "WCSDI_Scadenza::verifica($ID_A);" >/dev/null 2>&1 || true
STATO_DOPO=$(wp eval "echo wc_get_order($ID_A)->get_status();" | tr -d '\r')
pagato "la scadenza non tocca un ordine gia' pagato" "$STATO_DOPO"

echo
echo "== 10. verifico il checkout a blocchi =="
BLOCKS=$(wp eval '
if ( ! class_exists("WCSDI_Blocks") ) { echo "classe assente"; return; }
$b = new WCSDI_Blocks(); $b->initialize();
$d = $b->get_payment_method_data();
echo ( $b->is_active() && ! empty($d["title"]) ) ? "ok" : "non attivo";
' | tr -d '\r')
verifica "metodo registrato per il checkout a blocchi" "$BLOCKS" "ok"

if [ "$FATTURAZIONE" = "1" ]; then
  echo
  echo "== 11. verifico la nota di credito =="
  # Un rimborso su un ordine gia' fatturato deve produrre la nota.
  wp eval "wc_create_refund( array( 'order_id' => $ID_A, 'amount' => 10.00, 'reason' => 'Reso parziale di prova' ) );" >/dev/null 2>&1 || true
  # L'azione puo' essere presa in carico dal runner del container cronrunner
  # nello stesso istante: il runner lanciato qui la trova gia' assegnata e
  # non la esegue. Si attende l'esito, chiunque lo produca, fino a due minuti.
  NOTA=""
  for _ in $(seq 1 24); do
    wp eval 'ActionScheduler::runner()->run();' >/dev/null 2>&1 || true
    NOTA=$(wp eval "foreach ( wc_get_order($ID_A)->get_refunds() as \$r ) { if ( \$r->get_meta('_wcsdi_nota_uuid') ) { echo \$r->get_meta('_wcsdi_nota_uuid'); break; } }" | tr -d '\r')
    [ -n "$NOTA" ] && break
    sleep 5
  done
  if [ -n "$NOTA" ]; then
    echo "  OK   nota di credito trasmessa ($NOTA)"
  else
    echo "  FAIL nota di credito non trasmessa"
    wp eval "foreach ( array_slice( wc_get_order_notes( array('order_id'=>$ID_A,'limit'=>3) ), 0, 3 ) as \$n ) { echo '       ' . substr( preg_replace('/\s+/', ' ', \$n->content), 0, 170 ) . PHP_EOL; }" 2>/dev/null || true
    falliti=$((falliti+1))
  fi
fi

echo
echo "== 12. verifico la configurazione REST =="
# Il servizio di rilevamento legge questo endpoint all'avvio: deve rifiutare
# le richieste senza segreto ed esporre la rete numerica attesa (RF-01).
CODICE_CFG=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8080/?rest_route=/wcsdi/v1/config" \
  -H "X-WCSDI-Secret: $SECRET")
verifica "GET /config con segreto risponde 200" "$CODICE_CFG" "200"

CORPO_CFG=$(curl -s "http://localhost:8080/?rest_route=/wcsdi/v1/config" -H "X-WCSDI-Secret: $SECRET")
echo "$CORPO_CFG" | grep -q '"chain_id":31337' \
  && echo "  OK   la configurazione riporta chain_id 31337" \
  || { echo "  FAIL chain_id atteso 31337 assente dal corpo: $CORPO_CFG"; falliti=$((falliti+1)); }

CODICE_CFG_NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8080/?rest_route=/wcsdi/v1/config")
verifica "GET /config senza segreto respinta" "$CODICE_CFG_NOAUTH" "401"

echo
echo "== 13. verifico il battito di vita del servizio =="
# Il silenzio di un servizio fermo non produce errori: l'unico modo per
# accorgersene e' l'ultimo battito registrato sull'opzione.
BATTITO="$(wp option get wcsdi_watcher_heartbeat --format=json 2>/dev/null)" || BATTITO=''
BATTITO="$(echo "$BATTITO" | tr -d '\r')"
if [ -n "$BATTITO" ]; then
  echo "  OK   il battito di vita e' stato registrato: $BATTITO"
else
  echo "  FAIL il battito di vita risulta assente"
  falliti=$((falliti+1))
fi

echo
echo "== 14. verifico il numeratore concorrente =="
# Anno 1999 per non toccare la serie reale. Dieci processi separati, ognuno
# un container wp-cli a se': la concorrenza e' reale, non simulata in un
# solo processo PHP.
PID_NUM=()
for i in $(seq 1 10); do
  wp eval 'echo WCSDI_Fattura::prossimo_numero(1999);' > "/tmp/wcsdi-e2e-num-$i.txt" 2>&1 &
  PID_NUM+=("$!")
done
# "wait" senza argomenti attenderebbe anche il servizio di rilevamento, che
# gira in background dal passo 3 e non termina da solo: si attendono solo i
# PID appena avviati.
wait "${PID_NUM[@]}"

NUMERI=""
for i in $(seq 1 10); do
  # Il file contiene anche le righe di stato di "docker compose run" (create/
  # avvio del container), catturate dal 2>&1: il numero restituito da PHP e'
  # l'ultima sequenza di cifre, non l'intero contenuto del file.
  N=$(grep -Eo '[0-9]+' "/tmp/wcsdi-e2e-num-$i.txt" | tail -n 1)
  NUMERI="$NUMERI $N"
done
rm -f /tmp/wcsdi-e2e-num-*.txt

DISTINTI=$(echo $NUMERI | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')
verifica "il numeratore concorrente produce dieci valori distinti" "$DISTINTI" "10"
echo "       numeri ottenuti:$NUMERI"

wp option delete wcsdi_numeratore_1999 >/dev/null 2>&1 || true

echo
echo "== 15. verifico la validazione dell'input =="
ORD_D=$(wp eval "$CREA" | tr -d '\r')
ID_D=$(echo "$ORD_D" | awk '{print $1}'); REF_D=$(echo "$ORD_D" | awk '{print $2}')
TX_FITTIZIO="0x$(printf '11%.0s' {1..32})"

CODICE_D1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_D\",\"tx_hash\":\"0x00\",\"log_index\":0,\"amount\":\"1\"}")
verifica "tx_hash malformato respinto" "$CODICE_D1" "400"

CODICE_D2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_D\",\"tx_hash\":\"$TX_FITTIZIO\",\"log_index\":0,\"amount\":\"1\",\"chain_id\":1}")
verifica "chain_id diverso da quello atteso respinto" "$CODICE_D2" "409"

CORPO_D2=$(curl -s -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_D\",\"tx_hash\":\"$TX_FITTIZIO\",\"log_index\":0,\"amount\":\"1\",\"chain_id\":1}")
echo "$CORPO_D2" | grep -q 'wcsdi_chain_mismatch' \
  && echo "  OK   il corpo riporta wcsdi_chain_mismatch" \
  || { echo "  FAIL wcsdi_chain_mismatch assente dal corpo: $CORPO_D2"; falliti=$((falliti+1)); }

CODICE_D3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
  -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
  --data "{\"order_ref\":\"$REF_D\",\"tx_hash\":\"$TX_FITTIZIO\",\"log_index\":1,\"amount\":\"0\"}")
verifica "amount zero respinto" "$CODICE_D3" "400"

echo
echo "== 16. verifico le notifiche parallele (lock per ordine) =="
# Un ordine non ancora pagato on-chain, notificato otto volte in parallelo
# con lo stesso evento fittizio: il blocco per ordine deve serializzare le
# richieste, cosi' che l'incasso non si moltiplichi (RNF-03).
ORD_C=$(wp eval "$CREA" | tr -d '\r')
ID_C=$(echo "$ORD_C" | awk '{print $1}'); REF_C=$(echo "$ORD_C" | awk '{print $2}')
TX_C="0x$(printf '22%.0s' {1..32})"

PID_LOCK=()
for i in $(seq 1 8); do
  curl -s -X POST "http://localhost:8080/?rest_route=/wcsdi/v1/payment-confirmed" \
    -H 'Content-Type: application/json' -H "X-WCSDI-Secret: $SECRET" \
    --data "{\"order_ref\":\"$REF_C\",\"tx_hash\":\"$TX_C\",\"log_index\":0,\"amount\":\"49.90\",\"chain_id\":31337,\"block_number\":1}" \
    > "/tmp/wcsdi-e2e-lock-$i.json" 2>&1 &
  PID_LOCK+=("$!")
done
# Idem: si attendono solo gli otto curl appena avviati, non il servizio di
# rilevamento in background.
wait "${PID_LOCK[@]}"

NON_DUPLICATE=0
for i in $(seq 1 8); do
  CORPO="$(cat "/tmp/wcsdi-e2e-lock-$i.json")"
  if echo "$CORPO" | grep -q '"duplicate"'; then
    continue
  fi
  if echo "$CORPO" | grep -q 'wcsdi_busy'; then
    continue
  fi
  NON_DUPLICATE=$((NON_DUPLICATE+1))
  echo "       risposta non duplicata (#$i): $CORPO"
done
rm -f /tmp/wcsdi-e2e-lock-*.json

verifica "esattamente una risposta su otto non e' duplicata ne' occupata" "$NON_DUPLICATE" "1"

STATO_C=$(wp eval "echo wc_get_order($ID_C)->get_status();" | tr -d '\r')
PAID_C=$(wp eval "echo wc_get_order($ID_C)->get_meta('_wcsdi_paid_total');" | tr -d '\r')
pagato "ordine $ID_C risulta pagato" "$STATO_C"
importo_uguale "ordine $ID_C incassa una volta sola, non otto" "$PAID_C" "49.90"

echo
echo "== 17. verifico il riavvio del servizio con un evento in attesa =="
ORD_E=$(wp eval "$CREA" | tr -d '\r')
ID_E=$(echo "$ORD_E" | awk '{print $1}'); REF_E=$(echo "$ORD_E" | awk '{print $2}')

# Si paga senza minare altri blocchi: la conferma richiede due profondita' in
# piu' di quella del blocco che porta la transazione, e qui non deve
# maturare prima del riavvio.
node tools/local-chain/e2e-pay.mjs "$TOKEN" "$FORWARDER" "$CLIENTE_KEY" "$REF_E"
sleep 3
if grep -q "\[VISTO\].*${REF_E:0:10}" /tmp/wcsdi-e2e-watcher.log; then
  echo "  OK   il servizio ha visto il pagamento dell'ordine $ID_E prima del riavvio"
else
  echo "  FAIL il servizio non ha visto il pagamento dell'ordine $ID_E prima del riavvio"
  falliti=$((falliti+1))
fi

kill "$WATCHER" 2>/dev/null || true
wait "$WATCHER" 2>/dev/null || true
sleep 1

CONTEGGIO_ATTESA=$(node -e "const s = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(Object.keys(s.inAttesa || {}).length);" < /tmp/wcsdi-e2e-state.json)
if [ "${CONTEGGIO_ATTESA:-0}" -ge 1 ] 2>/dev/null; then
  echo "  OK   lo stato persistito conserva $CONTEGGIO_ATTESA evento/i in attesa dopo l'arresto"
else
  echo "  FAIL lo stato persistito non conserva alcun evento in attesa (letti '$CONTEGGIO_ATTESA')"
  falliti=$((falliti+1))
fi

RPC_URL=http://localhost:8545 \
FORWARDER_ADDRESS="$FORWARDER" \
CHAIN_ID=31337 \
TOKEN_ADDRESS="$TOKEN" \
FINALITY_MODE=confirmations \
CONFIRMATIONS=2 POLL_MS=1000 \
WCSDI_PLUGIN_URL=http://localhost:8080/?rest_route=/wcsdi/v1 \
WATCHER_STATE_FILE=/tmp/wcsdi-e2e-state.json \
AUTO_REDEEM=false \
node watcher/src/index.mjs > /tmp/wcsdi-e2e-watcher-restart.log 2>&1 &
WATCHER=$!
attendi_watcher /tmp/wcsdi-e2e-watcher-restart.log 20 || true

if grep -Eq "Ripartenza dal blocco.*, 1 in attesa," /tmp/wcsdi-e2e-watcher-restart.log; then
  echo "  OK   il log del secondo avvio riporta un evento in attesa alla ripartenza"
else
  echo "  FAIL il log del secondo avvio non riporta l'evento in attesa alla ripartenza"
  falliti=$((falliti+1))
fi

for _ in 1 2 3 4; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' \
    http://localhost:8545 >/dev/null
  sleep 1
done
sleep 4

STATO_E=$(wp eval "echo wc_get_order($ID_E)->get_status();" | tr -d '\r')
pagato "ordine $ID_E risulta pagato dopo il riavvio del servizio" "$STATO_E"

echo
echo "== 18. verifico il cessionario estero e il cliente senza codice fiscale =="
HA_COMPONI=$(wp eval 'echo ( class_exists("WCSDI_Fattura") && method_exists("WCSDI_Fattura", "componi") ) ? "si" : "no";' | tr -d '\r')
if [ "$HA_COMPONI" != "si" ]; then
  echo "  (saltato) WCSDI_Fattura::componi non disponibile"
else
  ESITO_ESTERO=$(wp eval '
$config = array(
  "fiscal_id" => "RSSMRA80A01H501U",
  "denominazione" => "Test Cedente",
  "regime" => "RF01",
  "natura_iva_zero" => "N2.2",
  "riferimento_normativo" => "",
  "sede" => array( "indirizzo" => "Via Test 1", "cap" => "00100", "comune" => "Roma", "provincia" => "RM", "nazione" => "IT" ),
);
$o = wc_create_order();
$o->set_currency("EUR");
$o->set_address( array(
  "country" => "DE", "first_name" => "Hans", "last_name" => "Muller",
  "address_1" => "Teststrasse 1", "postcode" => "10115", "city" => "Berlin",
), "billing" );
$o->update_meta_data("_wcsdi_piva", "DE123456789");
$item = new WC_Order_Item_Fee();
$item->set_name("Servizio di prova");
$item->set_total(10.00);
$item->set_total_tax(0);
$o->add_item($item);
$o->set_total("10.00");
$o->save();
try {
  $xml = WCSDI_Fattura::componi($o, $config, 1);
  $ok = ( strpos($xml, "<CodiceDestinatario>XXXXXXX</CodiceDestinatario>") !== false )
     && ( strpos($xml, "<IdPaese>DE</IdPaese>") !== false );
  echo $ok ? "ok" : "campi_assenti";
} catch (Exception $e) {
  echo "eccezione: " . $e->getMessage();
}
' | tr -d '\r')
  verifica "cessionario estero senza CF: CodiceDestinatario e IdPaese esteri" "$ESITO_ESTERO" "ok"

  ESITO_IT=$(wp eval '
$config = array(
  "fiscal_id" => "RSSMRA80A01H501U",
  "denominazione" => "Test Cedente",
  "regime" => "RF01",
  "natura_iva_zero" => "N2.2",
  "riferimento_normativo" => "",
  "sede" => array( "indirizzo" => "Via Test 1", "cap" => "00100", "comune" => "Roma", "provincia" => "RM", "nazione" => "IT" ),
);
$o = wc_create_order();
$o->set_currency("EUR");
$o->set_address( array(
  "country" => "IT", "first_name" => "Mario", "last_name" => "Bianchi",
  "address_1" => "Via Prova 1", "postcode" => "00100", "city" => "Roma", "state" => "RM",
), "billing" );
$item = new WC_Order_Item_Fee();
$item->set_name("Servizio di prova");
$item->set_total(10.00);
$item->set_total_tax(0);
$o->add_item($item);
$o->set_total("10.00");
$o->save();
try {
  WCSDI_Fattura::componi($o, $config, 1);
  echo "nessuna_eccezione";
} catch (Exception $e) {
  echo "ok";
}
' | tr -d '\r')
  verifica "cliente IT senza CF e senza P.IVA: la composizione lancia un'eccezione" "$ESITO_IT" "ok"
fi

echo
echo "--- log del servizio (primo avvio) ---"
cat /tmp/wcsdi-e2e-watcher.log
if [ -f /tmp/wcsdi-e2e-watcher-restart.log ]; then
  echo
  echo "--- log del servizio (riavvio) ---"
  cat /tmp/wcsdi-e2e-watcher-restart.log
fi

echo
if [ "$falliti" -eq 0 ]; then echo "Tutte le verifiche superate."; else echo "$falliti verifiche fallite."; fi
exit "$falliti"
