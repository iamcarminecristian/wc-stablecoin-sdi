=== WC Stablecoin SdI ===
Contributors: cruogliocarminecristian
Tags: woocommerce, payment gateway, stablecoin, fattura elettronica, sdi
Requires at least: 6.8
Tested up to: 7.1
Requires PHP: 8.1
WC requires at least: 10.0
WC tested up to: 11.0
Stable tag: 0.2.0
License: GPLv3
License URI: https://www.gnu.org/licenses/gpl-3.0.html

Incasso in euro tokenizzati (EURe, token di moneta elettronica ai sensi del regolamento MiCA) con riscatto automatico verso l'IBAN dell'esercente e fattura elettronica trasmessa al Sistema di Interscambio.

== Description ==

Prototipo di ricerca sviluppato per una tesi di laurea magistrale (Universita' degli Studi Guglielmo Marconi, 2026). Il plugin aggiunge a WooCommerce un metodo di pagamento in EURe su una rete compatibile EVM, correla ogni pagamento all'ordine attraverso un contratto di inoltro, riceve la conferma da un servizio di rilevamento esterno, dispone il riscatto alla pari presso l'emittente e trasmette la fattura elettronica a un fornitore accreditato.

Il plugin non custodisce fondi ne' chiavi: la capacita' di firma necessaria al riscatto vive nel servizio di rilevamento, un processo separato senza superficie pubblica, mai in WordPress.

Non e' destinato all'esercizio con denaro reale senza una revisione indipendente: e' stato esercitato su reti di prova e ambienti sandbox. Il codice completo, il servizio di rilevamento, il contratto e la documentazione sono nel repository del progetto.

== Installation ==

1. Copiare la cartella del plugin in `wp-content/plugins/` e attivarlo; richiede WooCommerce attivo.
2. In WooCommerce > Impostazioni > Pagamenti > Paga in EURe: rete, contratto del token, contratto di inoltro, indirizzo di incasso, criterio di conferma, segreto del servizio di rilevamento, dati del cedente, credenziali del fornitore SdI.
3. Pubblicare il contratto di inoltro (cartella `contracts/` del repository) e avviare il servizio di rilevamento (cartella `watcher/`) con lo stesso segreto.
4. Il sito deve essere servito in HTTPS: il pannello lo segnala in caso contrario.

== Frequently Asked Questions ==

= Il cliente deve fare qualcosa di diverso dal solito? =

Deve disporre di un portafoglio con EURe e con la valuta nativa della rete per il costo di rete, e invocare il contratto di inoltro con il riferimento dell'ordine mostrato dopo il checkout. Un trasferimento diretto all'indirizzo di incasso non viene riconosciuto e va restituito a mano.

= La fattura viene emessa sempre? =

Per i clienti azienda o professionista sempre; per i privati solo se la richiedono al checkout, secondo l'art. 22 del DPR 633/72.

== Changelog ==

= 0.2.0 =
* Numerazione delle fatture atomica; aliquota per riga; natura per le operazioni a IVA zero; cessionario estero; ritrasmissione dopo scarto.
* Campi fiscali del cessionario al checkout classico e a blocchi, con validazione.
* Criterio di conferma e segreto configurabili dal pannello; endpoint di configurazione e heartbeat per il servizio di rilevamento.
* Lock per ordine e validazione degli input sulla notifica di pagamento; margine di scadenza legato al criterio; riapertura di un ordine scaduto pagato in ritardo.
* Informativa precontrattuale al checkout e istruzioni di pagamento nell'email.
* Copia della fattura conservata in una cartella privata e consegnata al cliente per e-mail, allegata anche alle e-mail di ordine completato e di fattura (art. 1, c. 3, D.Lgs. 127/2015).

= 0.1.0 =
* Prima versione: gateway, contratto di inoltro, fatturazione, nota di credito, scadenza, checkout a blocchi, strumentazione di misura.
