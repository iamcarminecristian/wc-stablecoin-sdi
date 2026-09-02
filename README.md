# WC Stablecoin SdI

## Che cos'è

Un plugin WooCommerce che accetta pagamenti in EURe, un token di moneta
elettronica ai sensi del regolamento MiCA agganciato all'euro, converte
automaticamente l'incasso in euro tramite riscatto alla pari presso
l'emittente (Monerium) e trasmette la fattura elettronica al Sistema di
Interscambio tramite un fornitore accreditato (Openapi). La correlazione fra
pagamento on-chain e ordine WooCommerce passa da un contratto di inoltro
dedicato, e un servizio Node separato osserva la catena, applica un criterio
di conferma configurabile e notifica il negozio.

Il repository è il codice di una tesi di laurea magistrale LM-32
(Università degli Studi Guglielmo Marconi, candidato Carmine Cristian
Cruoglio, relatore Prof. Gian Luca Comandini, 2026) e ne costituisce il
materiale sperimentale: dataset, script di misura e documentazione tecnica
sono parte del Capitolo 6.

**Avvertenza.** Questo è un prototipo di ricerca, esercitato solo su reti di
prova (Base Sepolia; su chain locale per le verifiche automatiche) e ambienti sandbox degli emittenti
(Monerium, Openapi). Non è destinato all'esercizio con denaro reale senza
una revisione indipendente del codice e della configurazione.

## Architettura in breve

- **Plugin PHP** (`plugin/`): gateway di pagamento WooCommerce, endpoint REST
  per il servizio di rilevamento, fatturazione elettronica accodata su
  Action Scheduler, nota di credito sul rimborso, scadenza della finestra di
  pagamento, checkout sia classico sia a blocchi, campi fiscali del
  cessionario al checkout, copia della fattura conservata e inviata al
  cliente per e-mail.
- **Contratto di inoltro** `contracts/src/OrderForwarder.sol`: riceve il
  pagamento dal cliente, lo trasferisce all'indirizzo di incasso
  dell'esercente ed emette `OrderPaid(orderRef, payer, amount)`. Immutabile
  (token e indirizzo di incasso fissati alla costruzione), senza proprietario
  e senza funzioni amministrative.
- **Servizio di rilevamento** `watcher/`: osserva gli eventi `OrderPaid`,
  applica il criterio di conferma configurato (`confirmations`, `safe` o
  `finalized`), persiste lo stato su file (eventi in attesa, riscatti,
  orfani), verifica la canonicità del blocco prima di notificare, dispone il
  riscatto presso l'emittente con ritentativi a attesa crescente e invia un
  battito di vita al plugin.
- **Emittente Monerium** (sandbox `api.monerium.dev`): riscatto EURe → EUR
  verso l'IBAN dell'esercente.
- **Fornitore SdI Openapi** (sandbox `test.sdi.openapi.it`): trasmissione
  della FatturaPA e lettura dello stato di recapito.

### Flusso nominale, in sette passi

```
1. Checkout         Il cliente sceglie EURe; l'ordine ottiene un riferimento
                    (order_ref, HMAC-SHA256 dell'id ordine) e le istruzioni
                    di pagamento.
2. Pagamento        Il cliente invoca OrderForwarder (pay o payWithPermit):
                    gli EURe passano dal suo portafoglio all'indirizzo di
                    incasso, il contratto emette OrderPaid.
3. Rilevamento      Il watcher osserva l'evento, attende che soddisfi il
                    criterio di conferma configurato e rilegge la ricevuta
                    per verificare che il blocco sia ancora canonico.
4. Notifica         Il watcher chiama POST /payment-confirmed sul plugin;
                    il plugin riverifica il riferimento, blocca l'ordine
                    per la durata della notifica e transita lo stato.
5. Fatturazione     Il plugin accoda la composizione e la trasmissione
                    della FatturaPA su Action Scheduler, con numerazione
                    atomica e ritentativi sui guasti transitori.
6. Riscatto         Il watcher dispone il riscatto alla pari presso
                    l'emittente verso l'IBAN dell'esercente e ne segue
                    l'esito; comunica gli esiti al plugin.
7. Consegna         La fattura è conservata sul server e inviata per
                    e-mail al cliente; i marcatori t0-t5 restano
                    sull'ordine per l'esportazione del dataset.
```

## Avvio rapido

Requisiti: Docker con Compose v2, Node 22, `make`. Su Windows, Git Bash (gli
script del repository sono shell POSIX).

```bash
cp .env.example .env
make init    # prima accensione: provisioning WordPress + WooCommerce
make demo    # deploya un token di prova sulla chain locale e simula un pagamento
make e2e     # verifica end-to-end su anvil
```

Fatto: negozio su `http://localhost:8080/wp-admin` (admin / admin), chain
locale su `http://localhost:8545`. `make up` / `make down` per accendere e
spegnere, `make nuke` per ripartire da zero.

## Configurazione

Un solo file per tutto il monorepo, alla root: `.env`, mai committato
(escluso da `.gitignore`). `.env.example` ne documenta ogni variabile;
quelle già presenti nell'ambiente hanno la precedenza sul file, ed è così
che il flusso offline su anvil convive con la configurazione di testnet.

### Pannello del gateway

In WooCommerce → Impostazioni → Pagamenti → il metodo EURe, oltre a titolo,
descrizione e informativa precontrattuale al checkout:

- **Rete e rilevamento**: rete (selezione fra le reti su cui l'emittente
  distribuisce EURe, incluse le rispettive reti di prova), contratto del
  token EURe, indirizzo di incasso, contratto di inoltro, criterio di
  conferma (`finalized`, `safe`, conteggio delle conferme) con il numero di
  conferme richieste, finestra di pagamento in minuti, segreto del servizio
  di rilevamento (sincronizzato nell'opzione che gli endpoint REST leggono,
  il campo del pannello resta vuoto dopo il salvataggio).
- **Fatturazione elettronica (SdI via openapi.it)**: endpoint del fornitore
  (sandbox o produzione), token del fornitore, dati del cedente (partita IVA
  o codice fiscale, denominazione, indirizzo, CAP, comune, provincia,
  regime fiscale), natura e riferimento normativo per le operazioni senza
  IVA.
- La sezione «Conversione automatica in EUR» è solo informativa: il
  riscatto richiede una firma dell'indirizzo di incasso, quindi si
  configura nel servizio di rilevamento e non nel pannello, perché il
  plugin non deve mai custodire chiavi.

### Pubblicare il contratto di inoltro

```bash
cd contracts
npm install && npm run compile
npm test                              # su anvil, con `make up` attivo
npm run deploy                        # chain locale
DEPLOY_TARGET=live DEPLOYER_PRIVATE_KEY=0x... npm run deploy   # rete di RPC_URL
```

Il deploy stampa l'indirizzo da riportare in `FORWARDER_ADDRESS` nel `.env`
e nel pannello. Token e indirizzo di incasso sono fissati alla costruzione:
non si possono cambiare senza ripubblicare il contratto.

### Avviare il servizio di rilevamento

Fuori dai container:

```bash
cd watcher
npm install
npm start
```

Oppure dentro Docker Compose, profilo `full` (il servizio legge il `.env`
alla root; dentro la rete di compose il plugin si raggiunge come
`http://wordpress/`, non come `localhost`):

```bash
docker compose --profile full up watcher
```

### Nota sull'URL REST

L'immagine Docker di WordPress usata in sviluppo non riscrive `/wp-json/`:
l'endpoint REST del plugin si raggiunge con la query string
`?rest_route=/wcsdi/v1/...`, forma già impostata in `WCSDI_PLUGIN_URL` in
`.env.example`.

## Riprodurre il Capitolo 6

### Ambiente di misura

Rete Base Sepolia (chain id 84532). Contratto di inoltro
`0x91f7B2252256a112Fe12Ee79BA58e1cb290D21C3`, token EURe
`0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85`. Versioni della piattaforma
fissate al digest in `docker-compose.yml` (WordPress 7.1, WooCommerce
11.0.1, PHP 8.2.33, MariaDB 11.8.9; anvil 1.5.1 per la sola verifica
end-to-end).

### Campagne

```bash
node tools/local-chain/campagna-lotti.mjs \
  --ripetizioni=10 --criterio=confirmations:12 --modalita=allowance --campagna=<id>

node tools/local-chain/campagna-finalita.mjs \
  --criteri=confirmations:1,confirmations:12,safe,finalized --ripetizioni=5
```

`campagna-lotti.mjs` avvia da sé il servizio di rilevamento con il criterio
indicato ed esegue una tranche a lotti, riprendendo appena l'esercente
torna capiente; `campagna-finalita.mjs` ripete la stessa campagna breve
variando solo il criterio di conferma. `--modalita` sceglie come il cliente
autorizza il contratto (`allowance`, `approve`, `permit`); `--dry-run`
mostra il piano senza eseguire nulla.

### Esportazione e file laterali

```bash
docker compose run --rm -T wpcli wcsdi export --format=csv > docs/dataset/campagna-<data>.csv

node tools/ricevute.mjs --dataset=docs/dataset/campagna-<data>.csv \
  --chain-id=84532 --rpc=https://sepolia.base.org --out=docs/dataset/ricevute-<data>.csv

node tools/finalita-l2.mjs --grezzo=docs/dataset/finalita-<rete>-<data>-campioni.csv

node tools/parametri-mercato.mjs --out=docs/dataset/parametri-mercato-<data>.csv
```

`ricevute.mjs` integra la componente L1 del costo di rete, che il servizio
di rilevamento non registra; `finalita-l2.mjs --grezzo` campiona
l'arretrato delle etichette `safe`/`finalized`; `parametri-mercato.mjs`
osserva cambio ETH/EUR e prezzo del gas sulla rete principale.

### Analisi

```bash
node tools/analisi.mjs --dataset=docs/dataset/campagna.csv --campagna=<id> \
  --ricevute=docs/dataset/ricevute-<data>.csv --gas=docs/dataset/gas-<campagna>.csv \
  --latex=<dir> --json=<file>

node tools/statistica.mjs --test
```

`analisi.mjs` produce le tabelle del capitolo, in LaTeX su richiesta;
`statistica.mjs --test` esegue l'autoverifica delle funzioni statistiche
(Mann-Whitney, Kruskal-Wallis, bootstrap) senza toccare la rete. Protocollo
completo in `docs/protocollo-kpi.md`, schema e provenienza di ogni file in
`docs/dataset/README.md`.

## Verifica

```bash
make e2e       # verifica end-to-end su anvil
make contracts # compilazione e test del contratto
make analisi   # analisi statica del contratto con Slither
```

`make e2e` esegue 33 verifiche sul flusso di checkout, pagamento on-chain e
fatturazione, incluse la concorrenza sul numeratore delle fatture, le
notifiche parallele identiche sullo stesso ordine, il riavvio del servizio
di rilevamento con un evento in attesa e la ricerca di un ordine oltre i
cinque più recenti. `make contracts` esegue i test del contratto di
inoltro, incluso il pagamento con permit (EIP-2612); richiede `make up`
attivo. Prima di ogni commit: `php -l` sui file PHP toccati, `node --check`
sugli script toccati.

**Non lanciare `make e2e` mentre è in corso una campagna**: lo script
riconfigura temporaneamente il gateway su anvil, salvando e poi
ripristinando la configurazione precedente al termine.

## Struttura del repository

```
plugin/               plugin WooCommerce (PHP)
  wc-stablecoin-sdi.php    bootstrap, endpoint REST, avvisi in bacheca
  includes/
    class-wc-gateway-eure.php    gateway di pagamento e pannello
    class-wcsdi-checkout.php     campi fiscali al checkout classico
    class-wcsdi-blocks.php       registrazione del metodo al checkout a blocchi
    class-wcsdi-fatturazione.php orchestrazione della fatturazione (Action Scheduler)
    class-wcsdi-fattura.php      composizione del tracciato FatturaPA
    class-wcsdi-sdi-client.php   client HTTP verso il fornitore SdI
    class-wcsdi-nota-credito.php nota di credito sul rimborso
    class-wcsdi-scadenza.php     scadenza della finestra di pagamento
    class-wcsdi-copia-cliente.php conservazione e invio della copia al cliente
    class-wcsdi-misure.php       marcatori t0-t5 ed esportazione della riga
    class-wcsdi-export.php       comando wp wcsdi export
  assets/js/blocks.js        integrazione JS per il checkout a blocchi
contracts/             contratto di inoltro (Solidity) + compile, deploy, test
  src/OrderForwarder.sol
  build/                  artefatto compilato tracciato in git (quello pubblicato)
watcher/                servizio Node di rilevamento
  src/
    index.mjs               ciclo di osservazione e conferma
    config.mjs               lettura di .env e valori predefiniti
    notify.mjs                dialogo REST con il plugin
    redeem.mjs                riscatto presso Monerium
    state.mjs                  persistenza dello stato su file
tools/                  strumenti di misura e verifica
  local-chain/            MockEURe, deploy locale, campagne sperimentali
  analisi.mjs, statistica.mjs, ricevute.mjs, finalita-l2.mjs, parametri-mercato.mjs
  e2e.sh, e2e-setup.sh    verifica end-to-end
spikes/                 tre spike tecnici isolati, conservati come traccia
docs/                   documentazione tecnica e dataset (§ successiva)
docker-compose.yml      WordPress+WooCommerce, chain EVM locale, watcher (profilo full)
Makefile                init, up, down, nuke, demo, contracts, e2e, analisi
CLAUDE.md               istruzioni di progetto e log delle decisioni
```

## Documenti in `docs/`

- `protocollo-kpi.md`: protocollo KPI del Capitolo 6, con le note di
  attuazione per ogni voce.
- `dataset/README.md`: inventario e schema di ogni file del dataset
  sperimentale, campagna per campagna.
- `finalita-l2.md`: perché il conteggio delle conferme non misura la
  finalità su una rete di secondo livello, e la misura dell'arretrato di
  `safe`/`finalized`.
- `costo-in-euro.md`: come si converte in euro il costo di rete di una
  transazione, e perché il risultato è un intervallo.
- `sdi-notifiche.md`: perché le notifiche di recapito del SdI possono non
  arrivare nella finestra di una singola campagna.
- `rnf-04-minimizzazione.md`: verifica della minimizzazione dei dati
  personali trattati dal sistema.
- `analisi-sicurezza.md`: esito dell'analisi statica del contratto con
  Slither.
- `produzione.md`: guida all'esercizio in produzione.
- `sessioni/`: note di lavoro sui sandbox esterni.

## Licenza e citazione

Distribuito con licenza **GNU GPL v3** (vedi `LICENSE`).

Repository pubblico su GitHub, materiale sperimentale della tesi di laurea
magistrale sopra indicata. Il tag di riferimento per le citazioni sarà
`v0.1.0-tesi`.

## Cosa NON fa

- Non è mai stato esercitato su rete blockchain principale.
- Il riscatto di importi pari o superiori a 15.000 euro richiede un
  documento giustificativo che il flusso automatico non produce: va
  disposto manualmente presso l'emittente.
- Non restituisce automaticamente le eccedenze di pagamento o i pagamenti
  su ordini scaduti: il sistema le rileva e le annota sull'ordine con
  l'indirizzo di provenienza, ma la restituzione resta un'operazione
  manuale dell'esercente.
- Nell'ambiente Docker di sviluppo le e-mail spesso non vengono
  recapitate (nessun server SMTP configurato): il plugin lo rileva e lo
  annota sull'ordine, ma la consegna della copia della fattura al cliente
  in quel caso resta manuale.
