# Changelog

Tutte le modifiche rilevanti di questo progetto sono documentate in questo
file, ricostruito da `git log --reverse --date=short`. Formato basato su
[Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Ogni voce riporta
l'hash breve del commit corrispondente.

## [0.2.0] - 2026-09-02

Riscrittura successiva all'audit della campagna v1: numeratore delle fatture
atomico, checkout con dati fiscali del cessionario, watcher con stato
persistito, verifica di canonicità del blocco e riscatti ritentati, campagna
sperimentale v2, strumenti di analisi ampliati.

### Added

- Criterio di finalità a etichetta (`safe`, `finalized`) nel watcher, in
  aggiunta al conteggio delle conferme, con `finalized` come valore
  predefinito dal 2 settembre 2026 (`b319945`, `dde0b38`).
- Stato del watcher persistito su file (eventi in attesa, riscatti, orfani),
  verifica di canonicità del blocco prima di notificare, configurazione
  letta dal plugin via `GET /config` (`003fef3`).
- Campi fiscali del cessionario al checkout (tipo cliente, codice fiscale,
  partita IVA, codice destinatario, PEC, richiesta di fattura), criterio di
  conferma e segreto del servizio di rilevamento nel pannello del gateway,
  endpoint di configurazione e battito di vita, lock per ordine e
  validazione degli input sulla notifica di pagamento (`7cb0275`, v0.2.0).
- Copia del documento fiscale conservata sul server e inviata al cliente per
  e-mail, ai sensi dell'art. 1, c. 3, D.Lgs. 127/2015 (`89c1d3b`).
- Marcatore dell'istante di trasmissione della fattura e distanza dal
  momento di effettuazione nel dataset (`becc3db`).
- Modalità di autorizzazione del pagamento (`allowance`, `approve`,
  `permit`) e marcatore dell'istante di invio nella campagna sperimentale;
  verifica end-to-end estesa a concorrenza e riavvio (`3a20ab0`).
- Test del contratto per `payWithPermit` su chain locale con un mock
  EIP-2612 (`ca9f709`).
- Analisi statica del contratto con Slither aggiunta alla verifica
  (`07bbcd9`).
- Filtro per criterio di finalità e accettazione di più identificativi di
  campagna separati da virgola nell'analisi (`ab3c9e3`, `79db8af`).
- Rilevamento di cambio ETH/EUR e prezzo del gas su finestre dichiarate
  (`0022926`).
- Flusso di esclusione dei dati anomali, scomposizione delle latenze, test
  statistici, componente L1 del costo e soglia di convenienza
  nell'analisi (`1d6fc1e`).
- Latenza di trasmissione della fattura confrontata con il termine di
  dodici giorni nell'analisi (`91cf99e`).
- Rilettura delle ricevute con `l1Fee` e campionamento grezzo dell'arretrato
  di finalità (`1df584a`, `tools/ricevute.mjs`, `tools/finalita-l2.mjs`).
- Verifica end-to-end con attese robuste per fattura e rilevamento, 33
  verifiche (`0041273`).
- Dataset: tranche 1 e 2 dell'ampliamento a 80 e 400 osservazioni a 12
  conferme (`dd642eb`, `05a7905`); campagna v2 del 2 settembre in più
  tranche, con scansione dei criteri, permit, approve (`fd10893`,
  `c2bfbb1`, `dd8f303`, `b4b402c`).

### Changed

- Numeratore delle fatture reso atomico (`UPDATE ... LAST_INSERT_ID`),
  aliquota IVA presa da `WC_Tax` per riga, natura per le operazioni senza
  IVA, gestione del cessionario estero, ritrasmissione dopo scarto
  (`cc1827a`).
- Hash completo della transazione in `Causale` (al posto di
  `RiferimentoTesto`) e `MP05` qualificato con `AltriDatiGestionali`
  (`131b785`).
- Commenti riscritti in proporzione al codice che spiegano (`a06937a`).
- Runner dedicato per la coda di Action Scheduler (`c9a84ee`).
- Ordine di pagamento randomizzato e identificativo di campagna nello
  script di campagna (`23e22c8`).
- Tabelle LaTeX della scansione dei criteri e dei test statistici a colonne
  elastiche, intestazioni su due righe per il gas per modalità (`b180965`).

### Fixed

- La ricerca dell'ordine per riferimento nel data store classico filtrava
  di fatto solo fra gli ultimi cinque ordini, perché quel data store
  ignora la `meta_query` (`081ac63`).
- Marcatore t2 errato con i criteri di finalità a etichetta: si prendeva
  l'ora della testa etichettata invece dell'istante di osservazione
  (`3b30741`).
- Il marcatore dell'istante di invio della campagna non veniva scritto per
  un `JSON.stringify` mancante prima di `json_decode` (`d4a4167`).
- Il ciclo di verifica delle ricevute si fermava dopo la prima verifica
  (`377db64`).
- In modalità `approve` la campagna pagava prima che l'autorizzazione
  fosse visibile in lettura (`7a547c4`).
- Nessun avviso spurio quando l'aggregazione delle campagne nell'analisi è
  esplicita (`3b7226a`).
- Ripristino della configurazione del gateway e dell'artefatto del
  contratto dopo la verifica end-to-end (`5ea6419`).

### Docs

- Scelte fiscali documentate come assunte, non più in attesa di validazione
  (`58bf210`).
- Meta_query ignorata dal data store classico, documentata in CLAUDE.md
  (`d68579f`).
- Contratto di inoltro verificato su Blockscout, versione del compilatore
  dichiarata (`5d86b5f`).
- README riscritto con la riproduzione del Capitolo 6 e runbook di
  produzione (`0354957`).
- Perimetro fiscale riportato fra i limiti dichiarati del README
  (`63a7591`).
- Conteggio corretto delle richieste RPC giornaliere con sondaggio a
  cinque secondi, nella guida di produzione (`279489f`).
- Protocollo KPI pubblicato, README del dataset, versioni della piattaforma
  fissate nel `docker-compose.yml` (`85c7c69`).

## [0.1.0] - 2026-08-31

Stato del monorepo al 31 agosto 2026: spike tecnici validati, contratto di
inoltro, plugin e servizio di rilevamento in una prima versione consolidata,
prima campagna sperimentale su Base Sepolia.

### Added

- Commit iniziale del monorepo di tesi (`8f40b47`).
- Contratto di inoltro dei pagamenti (`OrderForwarder.sol`) con riferimento
  all'ordine (`ece1c8a`).
- Consolidamento del flusso di incasso fra watcher e plugin (`367a679`).
- Fatturazione elettronica accodata su Action Scheduler (`a9d1046`).
- Nota di credito sul rimborso, scadenza della finestra di pagamento,
  checkout a blocchi (`8c01ee6`).
- Strumentazione dei marcatori KPI (t0-t5) ed export del dataset
  (`8b0cace`).
- Script di campagna sperimentale automatizzata con flag di anomalia
  (`9a569b2`) e campagna a lotti con riduzione del dataset alle tabelle del
  Capitolo 6 (`28a5f28`).
- Prima campagna sperimentale eseguita su Base Sepolia (`d3715af`).
- Spike 2: ordine di redemption con firma isolata (`5d27c2d`).

### Changed

- `.env` unico alla root del monorepo, allineamento a Base Sepolia
  (`f3d7ce3`).
- Esiti di deploy locale esclusi dal versionamento (`a11f8de`).

### Fixed

- Destinazione dell'XML dello spike 3 relativa al file, non alla cwd
  (`5717670`).
- Stato dell'ordine e formato del timestamp nel redemption (`406d300`).
- Stati SdI allineati ai valori documentati, copertura estesa ai cinque
  giorni di attesa delle ricevute (`98380ab`).
- Anagrafica del beneficiario inviata negli ordini di riscatto, richiesta
  dall'emittente (`6184148`).
- Rimborsi non più duplicati e riconducibili all'ordine di origine
  (`a582f78`).

### Docs

- Ambienti sandbox documentati nel CLAUDE.md, nota di sessione archiviata
  (`1f2560c`).
- Collocazione della capacità di firma fissata nel watcher, non nel plugin
  (`1361e04`).
- Contratto di inoltro documentato nel README e nelle istruzioni di
  progetto (`f156625`).
- Note tecniche riformulate come specifiche accertate (`5bc4a0a`).

[0.2.0]: #020---2026-09-02
[0.1.0]: #010---2026-08-31
