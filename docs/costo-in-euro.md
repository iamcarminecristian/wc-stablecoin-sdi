# Come si converte in euro il costo di una transazione

Il costo di rete non è direttamente misurabile in laboratorio, e trattarlo come
se lo fosse produce un numero che sembra un dato e non lo è. Questa nota separa
ciò che è misurato da ciò che è osservato altrove, e spiega perché il risultato
è un intervallo e non un numero.

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
Va osservato sulla rete principale.

**Il tasso di cambio** è esterno a entrambe le reti.

Nessuno degli ultimi due è una costante, ed è qui che sta il punto: prendere il
valore di un singolo istante attribuirebbe al risultato una precisione che non
possiede. Nel biennio osservato il cambio ETH/EUR va da 1 378 a 4 081 euro, un
fattore tre. Un costo calcolato sulla quotazione di un pomeriggio non dice nulla
su quanto costerà una transazione fra sei mesi.

## Le osservazioni

Rilevate da `tools/parametri-mercato.mjs`, che scrive
`docs/dataset/parametri-mercato-2026-09-01.csv`.

| Grandezza | n | min | p05 | mediana | p95 | max | Finestra |
|---|---|---|---|---|---|---|---|
| Cambio ETH/EUR | 105 | 1 378,65 | 1 486,54 | 2 244,07 | 3 784,77 | 4 081,45 | 02/09/2024 – 31/08/2026, settimanale |
| Prezzo del gas su Base (gwei) | 168 | 0,00500 | 0,00500 | 0,00500 | 0,00502 | 0,01218 | 24/08/2026 – 31/08/2026, oraria |

Alla chiusura delle misure la quotazione a pronti valeva 2 126,615 euro,
prossima alla mediana del biennio.

Le due finestre hanno ampiezza diversa di proposito. Il cambio va osservato su
un orizzonte che comprenda almeno un ciclo di mercato; il prezzo del gas
interessa nella sua variabilità di breve periodo, che è quella cui un esercente
è esposto giorno per giorno.

Gas consumato dal pagamento tramite contratto di inoltro: **65 388** unità,
mediana sulle misure di campagna. Un trasferimento nativo, per confronto, ne
costa 21 000.

## Il risultato

| Caso | Gas | Cambio | Costo |
|---|---|---|---|
| favorevole | p05 | p05 | 0,000486 € |
| centrale | mediana | mediana | 0,000734 € |
| sfavorevole | p95 | p95 | 0,001241 € |
| estremo osservato | max | max | 0,003250 € |

Il caso sfavorevole è volutamente pessimistico: assume che congestione di rete e
massimo del cambio si presentino insieme, cosa che nella finestra osservata non
è mai accaduta.

Il termine di paragone è la sola componente fissa della tariffa di un
processore: 0,25 € per Stripe, 0,35 € per PayPal. Anche nel caso sfavorevole il
costo di rete è lo **0,5 % della sola parte fissa** di Stripe, prima ancora di
considerare la componente percentuale. Nell'estremo osservato resta all'1,3 %.

## Che cosa resta da dichiarare

Il costo di rete lo sostiene il cliente, mentre la commissione del processore la
sostiene l'esercente: sono grandezze confrontabili solo se il confronto è
dichiarato come costo complessivo dell'operazione, ripartito diversamente fra le
parti.

I parametri sono argomenti dello script di analisi, non costanti nel codice:

```
node tools/analisi.mjs --dataset=... --gas-p95=... --eth-p95=...
```

Rifare le misure in un altro momento obbliga a ridichiararli, ed è esattamente
ciò che si vuole.

## Fonti

- Quotazione ETH/EUR: `https://api.coinbase.com/v2/prices/ETH-EUR/spot`,
  interrogabile per data e quindi verificabile da un terzo.
- Prezzo del gas: `https://mainnet.base.org`, metodo `eth_getBlockByNumber`,
  campo `baseFeePerGas`.
