# Dataset sperimentale del Capitolo 6

Tutti i file di questa cartella sono prodotti da strumenti del repository e non sono mai stati modificati a mano. Ogni numero del Capitolo 6 della tesi si riottiene da questi file con `tools/analisi.mjs`; il protocollo che li ha generati e' in `docs/protocollo-kpi.md`.

## Ambiente di misura

Rete Base Sepolia (chain id 84532), RPC pubblico `https://sepolia.base.org`, blocchi ogni 2 secondi. Contratto di inoltro `0x91f7B2252256a112Fe12Ee79BA58e1cb290D21C3`, token EURe `0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85`. Emittente: sandbox Monerium (`api.monerium.dev`), riscatto verso IBAN simulato. Fornitore SdI: sandbox Openapi (`test.sdi.openapi.it`), tracciato FatturaPA 1.9.1. Piattaforma: WordPress 7.1, WooCommerce 11.0.1, PHP 8.2.33, MariaDB 11.8.9, Node 22, anvil 1.5.1 per la sola verifica end-to-end (immagini fissate al digest in `docker-compose.yml`). Negozio con fuso orario Europe/Rome; marcatori in secondi Unix (UTC).

## File

| File | Prodotto da | Contenuto |
|---|---|---|
| `campagna.csv` | `wp wcsdi export --format=csv` | Una riga per ordine del negozio (842 al 1 settembre 2026): tutte le campagne v1, comprese le prove su anvil e le serie scartate. E' il file grezzo, non un estratto. |
| `campagna-2026-08-31.csv`, `campagna-2026-08-31-rimborso.csv` | idem | Esportazioni intermedie del 31 agosto, conservate come storico. |
| `ricevute-2026-09-02.csv` | `tools/ricevute.mjs` | Ricevuta e transazione rilette dalla rete per ogni `tx_hash` del dataset (678 righe): blocco, hash del blocco, indice, gas usato, prezzo effettivo, priority fee, componente L1 (`l1_fee_wei`) con i parametri di calcolo, costo L2 e totale in wei. Serve a integrare le righe v1, che portavano il solo costo L2. |
| `gas-<campagna>.csv` | `tools/local-chain/campagna.mjs` (v2) | Per ogni pagamento: modalita' di autorizzazione (allowance, approve, permit), istante di invio, hash e gas delle transazioni di approve e di pagamento, esito. |
| `finalita-<rete>-2026-09-01.csv` | `tools/finalita-l2.mjs` | Prima misura del ritardo delle etichette `safe` e `finalized` (Base mainnet, Base Sepolia, Gnosis): 25 minuti a 15 secondi su Base, 8 minuti a 10 secondi su Gnosis. Campioni troppo brevi, sostituiti dalla misura lunga. |
| `finalita-<rete>-2026-09-02-campioni.csv` | `tools/finalita-l2.mjs --grezzo` | Campioni grezzi ogni 15 secondi per 48 ore (dal 2 settembre 2026, 07:00 UTC): testa, ritardo di `safe` e `finalized` in blocchi e secondi. |
| `finalita-<rete>-2026-09-02-lungo.csv` | idem | Riepilogo della misura lunga per rete. |
| `parametri-mercato-2026-09-01.csv` | `tools/parametri-mercato.mjs` | Cambio ETH/EUR (105 rilevazioni settimanali, settembre 2024-agosto 2026) e prezzo del gas su Base mainnet (168 blocchi orari, 24-31 agosto 2026), con quantili. Fonte e metodo in `docs/costo-in-euro.md`. |
| `baseline-psp-2026-08-31.csv` | trascrizione dei listini | Commissioni di Stripe e PayPal (tier, regione, data, URL). |
| `slither-2026-09-01.json` | `make analisi` | Esito dell'analisi statica del contratto. |

## Colonne di `campagna.csv`

Schema v2 (dal 2 settembre 2026; le esportazioni precedenti hanno un sottoinsieme delle colonne e `stato_rimborso` al posto di `stato_riscatto`).

Identificazione: `order_id`, `campagna` (identificativo assegnato dallo script, vuoto per gli ordini creati a mano o dalle prove iniziali), `binario`, `importo`, `valuta`, `chain` (nome configurato nel gateway), `chain_id` (rete effettivamente osservata dal servizio), `forwarder`.

Criterio di conferma: `criterio` (`confirmations`, `safe`, `finalized`; vuoto nelle righe anteriori al campo, dove vale `confirmations`), `conferme` (numero di conferme richieste, 0 con le etichette).

Transazione: `tx_hash`, `blocco`, `tx_index`, `gas_usato`, `gas_prezzo_wei`, `costo_gas_nativo` (esecuzione L2), `l1_fee_wei` (pubblicazione dei dati sul primo livello), `costo_totale_nativo`, `gas_approve` (gas dell'autorizzazione per ordine, se misurato).

Marcatori: `t0` creazione dell'ordine, `t_invio` trasmissione della transazione da parte dello script, `t1` ora del blocco che include la transazione, `t2` conferma secondo il criterio (ora del blocco con il conteggio delle conferme; istante di osservazione, quantizzato all'intervallo di sondaggio, con le etichette), `t3` ricezione della notifica dal plugin, `t4` riscatto disposto, `t5` lavorazione del riscatto dichiarata dall'emittente.

Latenze derivate: `latenza_conferma` (t2-t0), `latenza_riconcil` (t3-t0), `latenza_regolam` (t5-t0), `lat_attesa_invio` (t_invio-t0), `lat_inclusione` (t1-t_invio), `lat_profondita` (t2-t1), `lat_notifica` (t3-t2), `lat_riscatto` (t5-t4).

Esiti: `stato_ordine`, `esito`, `categoria_errore`, `stato_riscatto` (`processed`, `rejected`, `declined`, `failed`, o stato intermedio), `riscatto_motivo`.

Fattura: `fattura_numero`, `fattura_uuid`, `fattura_stato` (`marking` del fornitore), `fattura_accettata`, `fattura_tentativi`, `sdi_verifiche`, `imponibile`, `imposta`.

Qualita': `anomalia_orologio` (1 se un marcatore precede il precedente: succede sulla chain di sviluppo, i cui blocchi non hanno un orario coerente con il server).

## Campagne v1 (31 agosto - 1 settembre 2026)

| Identificativo | Righe | Criterio | Uso nella tesi |
|---|---|---|---|
| (vuoto), chain_id vuoto | 164 | | Prove sulla chain di sviluppo e ordini manuali: escluse. |
| (vuoto), 84532, senza criterio | 44 | | Prove iniziali su rete di prova prima dell'introduzione del campo criterio: escluse. |
| (vuoto), 84532, 12 conferme | 114 | 12 | Prove di messa a punto senza identificativo di campagna: escluse. |
| `2026-09-01-paniere-completo` | 240 | 12 | Campagna principale, tranche 1 (8 importi x 30). |
| `ampliamento-t1-2026-09-01`, `ampliamento-t2-2026-09-01` | 80 + 80 | 12 | Campagna principale, tranche 2 e 3 (8 importi x 10), stesso giorno locale. |
| `2026-09-01-finalita-1`, `-3`, `-6`, `-24` | 15 ciascuna | 1, 3, 6, 24 | Scansione del criterio, paniere ridotto (25, 100, 500 x 5). |
| `2026-09-01-finalita-safe`, `2026-09-01-finalita-finalized` | 15 ciascuna | safe, finalized | Prima serie a etichetta, con t2 preso dall'ora della testa etichettata: t2 errato, escluse (vedi `docs/finalita-l2.md`). |
| `2026-09-01-safe-v2`, `2026-09-01-finalized-v2` | 15 ciascuna | safe, finalized | Seconda serie a etichetta, con t2 all'istante di osservazione: usate. |

Difetti noti della campagna v1, riportati nella tesi come risultati e non corretti a posteriori: il numeratore delle fatture non era atomico e due runner concorrenti hanno prodotto numeri duplicati (30 su 400 nella campagna principale), che il sandbox del fornitore ha accettato; la latenza t1-t0 include la coda dello script, che paga gli ordini in sequenza (mediana circa 10 secondi), non separabile perche' l'istante di invio non era registrato; i riscatti di quattro campagne brevi sono incompleti (14/15, 14/15, 13/15, 14/15) per un messaggio di riscatto duplicato nello stesso secondo e per l'arresto del servizio dopo 30 secondi.

## Campagne v2 (dal 3 settembre 2026)

Eseguite con il codice corretto (numeratore atomico, istante di invio, riscatti persistiti e ritentati, componente L1 nel costo). Identificativi e composizione verranno aggiunti qui a ogni tranche.
