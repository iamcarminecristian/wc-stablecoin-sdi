# Come si converte in euro il costo di una transazione

Il costo di rete non è direttamente misurabile in laboratorio, e trattarlo come
se lo fosse produce un numero che sembra un dato e non lo è. Questa nota separa
ciò che è misurato da ciò che è osservato altrove e da ciò che resta un'ipotesi
dichiarata.

## I tre termini

Il costo in euro di una transazione è il prodotto di tre grandezze, e solo la
prima appartiene all'esperimento.

**Il gas consumato** è una proprietà del contratto e del percorso di codice
eseguito. Si misura sulla rete di prova e il valore è trasferibile alla rete
principale, perché il costo delle singole istruzioni della macchina virtuale non
dipende dalla rete. È il dato sperimentale.

**Il prezzo del gas** non è trasferibile. Su Base Sepolia non c'è domanda di
blocco e il prezzo non riflette alcuna congestione reale; usarlo per stimare un
costo di esercizio significherebbe misurare il laboratorio anziché il fenomeno.
Va osservato sulla rete principale, con data e finestra dichiarate.

**Il tasso di cambio** è esterno a entrambe le reti e va citato con fonte e
istante di rilevazione.

## Le osservazioni

Rilevate il 31 agosto 2026.

| Grandezza | Valore | Provenienza |
|---|---|---|
| Gas del pagamento tramite contratto di inoltro | 65 388 | misurato in campagna su Base Sepolia |
| Gas di un trasferimento nativo, per confronto | 21 000 | costo di riferimento della macchina virtuale |
| Base fee mediana su Base mainnet | 0,005 gwei | `eth_getBlockByNumber` su `https://mainnet.base.org`, 10 blocchi campionati fra le 21:20:13 e le 21:35:13 UTC; min e max coincidono con la mediana |
| Prezzo del gas corrente su Base mainnet | 0,006 gwei | `eth_gasPrice` sullo stesso nodo, 21:35 UTC |
| ETH/EUR spot | 2 134,975 EUR | `https://api.coinbase.com/v2/prices/ETH-EUR/spot`, 21:35 UTC |

## Il risultato

Con la base fee mediana osservata, il pagamento costa 0,000 000 326 94 ETH, che
al tasso rilevato fa **0,00070 EUR**. Un trasferimento nativo, se il contratto
di inoltro non ci fosse, costerebbe 0,000 000 105 ETH, cioè 0,00022 EUR: il
contratto triplica il costo di rete, e su questa scala la differenza è di
cinque decimillesimi di euro.

Il termine di paragone è la sola componente fissa della tariffa di un
processore: 0,25 EUR per Stripe, 0,35 EUR per PayPal. Il costo di rete è
inferiore di due ordini di grandezza *alla sola parte fissa*, prima ancora di
considerare la componente percentuale.

## Che cosa resta ipotesi

Il prezzo del gas su una rete di secondo livello è volatile e la finestra
osservata è di quindici minuti in un momento di quiete: il valore va inteso come
un ordine di grandezza in condizioni non congestionate, non come una media di
esercizio. Il tasso di cambio è quello di un istante. Entrambi vanno ridichiarati
se le misure vengono rifatte.

Resta inoltre che il costo di rete lo sostiene il cliente, mentre la commissione
del processore la sostiene l'esercente: sono grandezze confrontabili solo se il
confronto è dichiarato come costo complessivo dell'operazione, ripartito
diversamente fra le parti.
