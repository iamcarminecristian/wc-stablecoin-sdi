# Guida all'esercizio in produzione

Questo documento descrive che cosa serve, oltre al codice, per portare il
sistema fuori dall'ambiente Docker di sviluppo. È materiale per l'Appendice C
della tesi: un lettore che volesse esercitare il prototipo con un negozio
reale deve trovare qui ogni passo, non doverlo dedurre dal codice.

Il prototipo resta quanto descritto nel `README.md`: non è stato esercitato
con denaro reale, e questa guida non sostituisce una revisione indipendente
del codice, della configurazione fiscale e dei contratti con gli emittenti.

## Prerequisiti

- Hosting servito in **HTTPS**: il pannello del gateway lo segnala se manca
  (avviso in bacheca), perché il segreto condiviso con il servizio di
  rilevamento viaggia in chiaro nell'header `X-WCSDI-Secret`.
- **PHP 8.1+**, **WooCommerce 10.0+** su WordPress 6.8+ (dichiarati in
  `plugin/readme.txt`); il plugin dichiara la compatibilità con HPOS e con
  il checkout a blocchi nel proprio bootstrap.
- **Node 22** su un host separato per il servizio di rilevamento
  (`watcher/`): non deve girare nello stesso processo di WordPress, perché
  ospita l'unica chiave privata del sistema.
- Un account **Monerium** in produzione (`api.monerium.app`, non il sandbox
  `.dev`), con l'IBAN di accredito collegato all'indirizzo di incasso e la
  verifica KYB completata: senza il collegamento fra IBAN e indirizzo il
  watcher rifiuta di avviarsi (verifica `ibanCollegato()` in
  `watcher/src/redeem.mjs`).
- Un account **Openapi** in produzione (`sdi.openapi.it`, non
  `test.sdi.openapi.it`) con credito impostato da dashboard.
- La **partita IVA del cedente**, non il codice fiscale personale: il campo
  «Partita IVA cedente» del pannello lo segnala esplicitamente, perché in
  produzione il SdI verifica che il cedente sia presente in Anagrafe
  Tributaria e scarta altrimenti con l'errore **00301**. Il codice fiscale
  cedente, accettato dal fornitore in ambiente di prova, non basta in
  produzione.

## Pubblicare il contratto di inoltro

Il contratto `contracts/src/OrderForwarder.sol` fissa token e indirizzo di
incasso alla costruzione e non espone modo di cambiarli:

```bash
cd contracts
npm install && npm run compile
DEPLOY_TARGET=live DEPLOYER_PRIVATE_KEY=0x... npm run deploy
```

`DEPLOYER_PRIVATE_KEY` è la chiave che paga il gas del deploy: si passa da
shell, non dal `.env` del repository, perché è un'operazione una tantum
dell'esercente e non una credenziale di esercizio. `RPC_URL`, `TOKEN_ADDRESS`
e `WATCH_ADDRESS` (l'indirizzo di incasso) devono essere già impostati nel
`.env`. Il comando stampa l'indirizzo da riportare in `FORWARDER_ADDRESS`.

**Se cambia l'IBAN o l'indirizzo di incasso, il contratto va ripubblicato.**
Non c'è un percorso di aggiornamento: un nuovo indirizzo di incasso richiede
un nuovo contratto, un nuovo valore di `FORWARDER_ADDRESS` nel pannello e nel
`.env` del watcher, e il collegamento del nuovo IBAN presso l'emittente
prima di riavviare il servizio.

## Configurazione del pannello

In WooCommerce → Impostazioni → Pagamenti → il metodo EURe:

- **Rete**: quella su cui è stato pubblicato il contratto di inoltro e su
  cui l'IBAN è collegato presso l'emittente. Le due cose devono coincidere,
  o il watcher rifiuta i pagamenti osservati su una rete diversa.
- **Contratto del token EURe**, **Indirizzo di incasso**, **Contratto di
  inoltro**: gli indirizzi ottenuti nei passi precedenti.
- **Criterio di conferma** e **Conferme richieste**: vedi la sezione
  successiva.
- **Segreto del servizio di rilevamento**: vedi sotto.
- Sezione **Fatturazione elettronica**: endpoint del fornitore
  (`https://sdi.openapi.it` in produzione), token del fornitore, dati
  completi del cedente (partita IVA, denominazione, indirizzo, CAP, comune,
  provincia, regime fiscale RF01-RF19), natura e riferimento normativo per
  le operazioni senza IVA se il regime del cedente lo richiede: senza,
  una riga a aliquota zero non viene trasmessa (errore non transitorio,
  segnalato sull'ordine).

Le credenziali dell'emittente (Monerium) non compaiono nel pannello di
proposito: il riscatto richiede una firma dell'indirizzo di incasso, e
quella capacità vive solo nel servizio di rilevamento.

## Segreto condiviso

Il segreto autentica ogni chiamata fra il servizio di rilevamento e il
plugin (header `X-WCSDI-Secret`, confrontato con `hash_equals`). Va generato
con margine di casualità:

```bash
openssl rand -hex 32
```

e impostato **identico** in due punti: nel campo «Segreto del servizio di
rilevamento» del pannello (che lo scrive nell'opzione `wcsdi_watcher_secret`
e si svuota dopo il salvataggio) e in `WCSDI_SHARED_SECRET` nel `.env` del
servizio di rilevamento. In alternativa, da riga di comando:

```bash
wp option update wcsdi_watcher_secret <valore>
```

Se i due valori divergono, ogni notifica viene respinta con 401 e i
pagamenti restano orfani finché non si corregge.

## Avviare il servizio come servizio di sistema

Il servizio è un processo Node singolo (`node src/index.mjs`, o `npm start`
dentro `watcher/`), pensato per girare senza supervisione. Esempio di unit
systemd:

```ini
[Unit]
Description=WC Stablecoin SdI - servizio di rilevamento
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/wc-stablecoin-sdi/watcher
EnvironmentFile=/opt/wc-stablecoin-sdi/.env
Environment=WATCHER_STATE_FILE=/var/lib/wcsdi-watcher/state.json
ExecStart=/usr/bin/node src/index.mjs
Restart=on-failure
RestartSec=10
User=wcsdi-watcher

[Install]
WantedBy=multi-user.target
```

Punti da rispettare:

- **`WATCHER_STATE_FILE` su un disco persistente**, fuori dalla directory
  del codice: contiene gli eventi in attesa di conferma, i riscatti in
  corso e gli eventi orfani. Il servizio riparte dallo stato salvato con
  scrittura sincronizzata su disco e rename atomica, ma solo se il file
  sopravvive al riavvio.
- **Backup di `state.json`**: perderlo non causa doppi accrediti, perché
  l'idempotenza vive lato plugin sulla chiave `txHash:logIndex` e sul lock
  per ordine, ma fa perdere la traccia degli eventi non ancora confermati e
  dei riscatti in corso, che tornano a dover essere ricostruiti dalla
  catena.
- **`START_BLOCK` alla primissima accensione**: senza, il servizio parte
  dalla testa della catena e non vede gli eventi antecedenti. Va impostato
  al blocco di pubblicazione del contratto di inoltro o a un blocco
  precedente noto.
- **Provider RPC dedicato, con quota adeguata al criterio scelto**: con il
  conteggio delle conferme il sondaggio è ogni 5 secondi (predefinito),
  circa diciassettemila richieste al giorno (86 400 secondi diviso 5); con le etichette `safe`/`finalized`
  l'intervallo predefinito sale a 30 secondi. Un provider pubblico
  condiviso può bastare in sviluppo, non in esercizio continuo.
- **Un secondo provider come piano di riserva**: il servizio non lo gestisce
  da solo, ma un'interruzione del provider RPC ferma il rilevamento; tenerne
  uno di scorta, anche solo annotato per un cambio manuale di `RPC_URL`, è
  prudente in esercizio, meno necessario in sviluppo dove un'interruzione
  costa solo il riavvio.

## Criterio di conferma consigliato

Il conteggio delle conferme non è un criterio di finalità su una rete di
secondo livello: i blocchi restano revocabili finché il lotto che li
contiene non è pubblicato e finalizzato sulla rete sottostante (dettagli in
`finalita-l2.md`). Indicazioni pratiche:

- Su una rete di secondo livello (Base e simili): **`finalized`**. È
  l'unico criterio con una garanzia dimostrabile, e qui la conferma innesca
  due azioni irreversibili fuori catena, il riscatto e la trasmissione
  della fattura. L'arretrato misurato rispetto alla testa della catena va
  da circa 14 a circa 21 minuti su Base (mediana-p95 di `finalita-l2.md`).
- Su Gnosis Chain o su una rete di primo livello: **`confirmations`** resta
  corretto e va scelto esplicitamente, con un numero di conferme
  proporzionato al tempo di blocco della rete.

## Sorveglianza

- **Heartbeat nel pannello**: il servizio invia `POST /heartbeat` ogni
  minuto (intervallo fisso nel codice); se il negozio non ne riceve uno da
  più di dieci minuti, compare un avviso in bacheca (`admin_notices`) a chi
  ha il ruolo `manage_woocommerce`. Il silenzio di un servizio fermo non
  produce errori: va sorvegliato da qui, o da un controllo esterno sullo
  stesso endpoint.
- **Log del servizio**: `journalctl -u <unit>` se avviato con systemd, o i
  log del container se avviato con `docker compose --profile full up
  watcher`. Le decisioni sui riscatti falliti e sugli eventi orfani vi
  compaiono.
- **Coda di Action Scheduler**: in sviluppo il repository usa un container
  dedicato che forza `wp action-scheduler run --force` ogni minuto, perché
  il cron di WordPress in loopback non raggiunge il container dall'interno.
  In produzione va sostituito con **WP-Cron reale** (traffico normale del
  sito, che lo attiva) o, meglio per un sito a basso traffico, un **cron di
  sistema** che invochi `wp action-scheduler run` a intervalli regolari.
  Senza un runner della coda, fatture e note di credito restano accodate e
  mai trasmesse, senza alcun errore visibile.
- **Verifica delle ricevute SdI**: lo stato di recapito (`marking`) viene
  riletto da Action Scheduler fino a un esito definitivo o a
  `MAX_VERIFICHE` tentativi (48, distribuiti su poco più di nove giorni).
  Per le fatture trasmesse prima che questo riaccodamento fosse
  disponibile, `tools/riaccoda-verifiche.php` rimette in coda la verifica
  di ogni ordine fatturato senza uno stato definitivo:

  ```bash
  docker compose run --rm -v "$PWD/tools:/tools" wpcli eval-file /tools/riaccoda-verifiche.php
  ```

## Casi operativi

### Pagamenti orfani

Un pagamento il cui riferimento non corrisponde a nessun ordine del negozio
(risposta 404 con codice `wcsdi_order_not_found`) viene registrato come
orfano nello stato del servizio (`orfani` in `state.json`, fino a 500
voci) e non ritentato: non è un errore transitorio, è denaro arrivato al
contratto con un riferimento che questo negozio non ha emesso. Verificarlo
nei log del servizio e, se necessario, disporre a mano la restituzione
verso l'indirizzo di provenienza registrato nell'evento.

### Eccedenze e pagamenti scaduti con incasso parziale

Il plugin non restituisce automaticamente nulla. Un pagamento in eccesso
aggiorna il meta `_wcsdi_da_restituire` sull'ordine e aggiunge una nota con
l'indirizzo di provenienza; lo stesso accade per un ordine chiuso alla
scadenza della finestra di pagamento con un incasso solo parziale. In
entrambi i casi la restituzione resta un'operazione manuale dell'esercente,
verso l'indirizzo riportato nella nota dell'ordine.

### Riscatti falliti

Quando il watcher riceve dall'emittente uno stato non definitivo in senso
positivo (`rejected`, `declined`, `failed`, o uno stato non riconosciuto),
lo comunica al plugin, che imposta il meta `_wcsdi_riscatto_da_verificare`
e aggiunge una nota sull'ordine («Riscatto presso l'emittente non concluso
...»). La fattura resta valida, perché l'operazione fiscale si è
perfezionata con il pagamento, ma gli EURe restano sull'indirizzo di
incasso e vanno trattati con l'emittente: filtrare gli ordini con quel meta
per individuarli.

Un importo pari o superiore a **15.000 euro** non viene riscattato
automaticamente: l'emittente richiede un documento giustificativo che il
flusso non produce (`SOGLIA_DOCUMENTO_EUR` in `watcher/src/redeem.mjs`), e
il riscatto va disposto manualmente dal pannello dell'emittente.

### Scarti del SdI

Una fattura scartata (`rejected`) o ferma per un errore non transitorio
(`errore`, con nota «Fatturazione ferma, serve un intervento manuale») si
ritrasmette, con lo stesso numero progressivo già assegnato, entro cinque
giorni dalla notifica di scarto:

```bash
wp wcsdi ritrasmetti <order_id>
```

Oppure dalla scheda dell'ordine, azione «Ritrasmetti la fattura al SdI»,
disponibile solo quando lo stato è ritrasmettibile.

## Rotazione del segreto e della chiave di firma

**Segreto condiviso**: si può ruotare in ogni momento. Generare un nuovo
valore, aggiornare `WCSDI_SHARED_SECRET` nel `.env` del servizio, riavviarlo,
poi impostare lo stesso valore nel campo del pannello. Nella finestra fra i
due passaggi le notifiche vengono respinte con 401 e ritentate dal servizio,
quindi nessun evento va perso, ma conviene minimizzarla.

**Chiave di firma** (`MERCHANT_SIGNER_PRIVATE_KEY`): non è ruotabile in
isolamento. È la chiave dell'indirizzo di incasso, e quell'indirizzo è
fissato immutabile nel contratto di inoltro pubblicato: il servizio verifica
all'avvio che la chiave corrisponda esattamente all'indirizzo configurato e
si rifiuta di procedere altrimenti. Sostituire la chiave significa cambiare
indirizzo di incasso, il che richiede di ripetere l'intera procedura di
pubblicazione: nuovo indirizzo, nuovo collegamento IBAN presso l'emittente,
nuovo contratto di inoltro, aggiornamento di `FORWARDER_ADDRESS` e
`MONERIUM_WALLET_ADDRESS`/indirizzo di incasso nel pannello.

## Aggiornamento del plugin

Il plugin non ha una toolchain di build: anche il JavaScript del checkout a
blocchi (`plugin/assets/js/blocks.js`) è distribuito così com'è. Aggiornare
significa sostituire i file della cartella del plugin (o il contenuto del
volume montato, in Docker) e verificare che Action Scheduler non abbia
lavori in coda che presuppongano il codice precedente: la coda persiste nel
database e riprende con il codice nuovo al primo giro del runner.

## Disinstallazione

Il plugin non registra un hook di disinstallazione: disattivarlo o
rimuoverlo non cancella nulla. Restano nel database:

- le opzioni (`woocommerce_wcsdi_eure_settings`, `wcsdi_watcher_secret`,
  `wcsdi_watcher_heartbeat`, e una `wcsdi_numeratore_<anno>` per ogni anno
  in cui sono state emesse fatture);
- i metadati sugli ordini (riferimento di pagamento, marcatori t0-t5, dati
  fiscali del cessionario, stato e identificativo della fattura, stato del
  riscatto);
- i file in `wp-content/uploads/wcsdi-fatture/` (tracciati XML trasmessi,
  cartella protetta da un `.htaccess` che nega l'accesso diretto).

Una rimozione completa richiede di cancellare questi elementi a mano, tenendo
presente l'obbligo di conservazione descritto sotto prima di farlo.

## Conservazione decennale delle fatture

Ogni fattura trasmessa viene conservata come tracciato XML in
`wp-content/uploads/wcsdi-fatture/` e una copia è inviata al cliente per
e-mail (allegata anche alle e-mail di ordine completato e di fattura che
WooCommerce reinvia), ad adempimento dell'art. 1, comma 3, D.Lgs. 127/2015:
la messa a disposizione nell'area riservata dell'Agenzia delle Entrate non
esaurisce l'obbligo di consegna al cliente. Il termine di conservazione
delle fatture elettroniche è di dieci anni: la cartella di conservazione
locale va inclusa nei backup del sito con la stessa politica di ritenzione,
e non va mai svuotata per liberare spazio.
