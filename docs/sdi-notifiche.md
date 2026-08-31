# Perché le ricevute del SdI non arrivano

Verifica condotta il 2026-08-31 sull'ambiente `test.sdi.openapi.it`, per stabilire
se il silenzio osservato sia un difetto dell'integrazione, un limite dell'ambiente
di prova, o semplicemente un'attesa dentro i termini previsti.

## Che cosa si osserva

Trenta fatture trasmesse, tutte accettate dal fornitore con `marking: "sent"`, a
ciascuna delle quali è stato assegnato un nome di file conforme alla convenzione
del Sistema di Interscambio (`IT10442360961ACB26_009vu.xml`) e un
`sdi_file_id` numerico. Il campo `notifications` è un array vuoto su tutte, e lo
è rimasto per l'intera finestra di osservazione, dell'ordine di alcune ore.

## Le due strade per ricevere le notifiche

La documentazione del fornitore ne prevede due, e sono alternative fra loro.

**Callback.** Si registrano con `POST /api_configurations`, scegliendo fra gli
eventi `supplier-invoice`, `customer-invoice`, `customer-notification`
(«notifica di scarto o accettazione»), `legal-storage-missing-vat` e
`legal-storage-receipt`. È la strada che la documentazione presenta per prima.

**Interrogazione.** `GET /invoices_notifications/{uuid}` restituisce le notifiche
di una singola fattura; lo stesso contenuto compare nel campo `notifications`
della risposta di `GET /invoices/{uuid}`.

Interrogando l'ambiente si è accertato che:

- `GET /api_configurations` restituisce `{"data": []}`: **nessuna callback è
  registrata**, il che è coerente con il fatto che l'installazione di prova vive
  su `localhost` e non è raggiungibile da un servizio esterno;
- `GET /invoices_notifications/{uuid}` risponde `200` con `{"data": []}`, quindi
  l'endpoint funziona e la risposta vuota è un'informazione, non un errore. La
  variante con il parametro in query (`?uuid=`) risponde `400 uuid is required`:
  l'identificativo va passato come segmento di percorso.

L'assenza di callback non spiega dunque il silenzio: l'interrogazione è una via
indipendente e dà lo stesso esito.

## Perché il silenzio non è (ancora) un'anomalia

L'Agenzia delle Entrate dichiara che «il Sistema di Interscambio effettua i
controlli e la consegna della fattura in tempi che possono variare da pochi
minuti ad un massimo di 5 giorni nel caso in cui è molto elevato il numero di
fatture che il SdI sta elaborando in quel momento».

La finestra di osservazione finora impiegata — alcune ore — cade quindi
comodamente dentro i termini dichiarati. Trarne una conclusione sarebbe
prematuro: **l'osservazione va condotta su giorni, non su ore**, e questo è un
vincolo del disegno sperimentale, non un difetto dell'integrazione.

Ne discende una conseguenza pratica sul protocollo di misura: il KPI di
integrità fiscale non può essere rilevato nella stessa sessione della campagna
di pagamento. Va rilevato con un'esportazione differita, a distanza di almeno
cinque giorni dalla trasmissione.

## Che cosa resta aperto

Se dopo cinque giorni le notifiche continuassero a mancare, resterebbe una sola
ipotesi da verificare, e non è verificabile dall'esterno: se l'ambiente di prova
inoltri realmente le fatture attive al canale di test dell'Agenzia oppure si
fermi alla validazione. La documentazione pubblica non lo dichiara. Documenta un
meccanismo di simulazione per le sole fatture *passive*
(`POST /simulate-supplier-invoice`, «valid only in Sandbox»); per le notifiche
delle fatture *attive* non ne documenta alcuno. È un'assenza indicativa ma non
probante, e la conferma può darla solo il fornitore.

## Un difetto trovato per strada

La verifica ha fatto emergere un errore nel plugin. I valori di `marking`
documentati dal fornitore usano il trattino — `delivered`, `delivered-pa`,
`not-delivered`, `rejected` — mentre il codice confrontava con `not_delivered`,
con il carattere di sottolineatura. Il confronto sarebbe stato sempre falso e il
KPI di integrità fiscale sarebbe rimasto a zero anche a notifiche arrivate,
producendo esattamente il risultato che si stava indagando. Corretto in
`WCSDI_Misure::MARKING_CONSEGNATA` e `MARKING_DEFINITIVI`, con i valori
raccolti in due costanti anziché ripetuti in due file.

## Fonti

- Openapi, *Documentazione Fatturazione Elettronica SDI* —
  <https://console.openapi.com/apis/sdi/documentation>
- Openapi, *FAQ Fatturazione Elettronica SDI* —
  <https://console.openapi.com/apis/sdi/faq>
- Agenzia delle Entrate, *Cosa fa il Sistema di Interscambio quando riceve una
  fattura* —
  <https://www.agenziaentrate.gov.it/portale/aree-tematiche/fatturazione-elettronica/guida-fatturazione-elettronica/come-predisporre-inviare-ricevere-fe/cosa-fa-sistema-interscambio-fe>
