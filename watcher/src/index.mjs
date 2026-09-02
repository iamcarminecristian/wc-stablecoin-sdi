// Servizio di rilevamento on-chain (paragrafo 4.3 della tesi).
//
// Osserva gli eventi OrderPaid del contratto di inoltro, applica il criterio
// di conferma configurato e notifica al plugin i pagamenti confermati; il
// plugin resta l'unica autorita' sullo stato dell'ordine. Se abilitato,
// dispone il riscatto alla pari verso l'IBAN dell'esercente e ne segue
// l'esito fino a uno stato terminale.
//
// Ogni OrderPaid emesso dal contratto e' per definizione un incasso
// dell'esercente, quindi il servizio non ha bisogno di conoscere in anticipo
// gli ordini in attesa: non esiste una registrazione preventiva da mantenere
// in sincronia, e il plugin ritrova l'ordine dal riferimento nell'evento.
//
// Tre proprieta' che il servizio garantisce, e che la versione precedente
// dichiarava senza realizzarle: gli eventi in attesa sopravvivono a un
// riavvio; prima di notificare si verifica che la transazione sia ancora
// nella catena canonica; un riscatto fallito viene ritentato e, se non
// riesce, portato all'attenzione dell'esercente.
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress } from 'viem';

import {
  RPC_URL, CHAIN_ID, FORWARDER, TOKEN_ADDRESS, CRITERI, FINALITY_MODE_ENV, CONFIRMATIONS_ENV,
  POLL_MS_ENV, DECIMALS, MAX_BLOCK_SPAN, STATE_FILE, START_BLOCK, REDEEM_ENABLED,
  MERCHANT_ADDRESS, RISCATTO_BACKOFF_MS, RISCATTO_POLL_MS,
} from './config.mjs';
import { caricaStato, salvaStato } from './state.mjs';
import { notificaPagamento, notificaRimborso, heartbeat, leggiConfigurazione } from './notify.mjs';
import { disponiRimborso, statoRimborso, esitoOrdine, configurazioneRimborsoCompleta, ibanCollegato } from './redeem.mjs';

const orderPaid = parseAbiItem(
  'event OrderPaid(bytes32 indexed orderRef, address indexed payer, uint256 amount)'
);

const client = createPublicClient({ transport: http(RPC_URL) });

const stato = caricaStato(STATE_FILE);
const notificate = new Set(stato.notificate);
const inAttesa = new Map(Object.entries(stato.inAttesa));

// Criterio, conferme e intervallo di sondaggio: variabili d'ambiente,
// altrimenti configurazione del plugin, altrimenti valori predefiniti.
let FINALITY_MODE = FINALITY_MODE_ENV ?? 'finalized';
let CONFIRMATIONS = CONFIRMATIONS_ENV ?? 12n;
let POLL_MS = POLL_MS_ENV ?? 30000;

const chiave = (log) => `${log.transactionHash}:${log.logIndex}`;
const salva = () => {
  stato.notificate = [...notificate];
  stato.inAttesa = Object.fromEntries(inAttesa);
  salvaStato(STATE_FILE, stato);
};

// Cache dei tempi di blocco: nel giro di osservazione lo stesso blocco ricorre
// per piu' eventi, e interrogare il nodo ogni volta sarebbe uno spreco.
const oraBlocco = new Map();

async function istanteBlocco(numero) {
  const k = numero.toString();
  if (!oraBlocco.has(k)) {
    const blocco = await client.getBlock({ blockNumber: numero });
    oraBlocco.set(k, Number(blocco.timestamp));
    if (oraBlocco.size > 2000) oraBlocco.delete(oraBlocco.keys().next().value);
  }
  return oraBlocco.get(k);
}

// Ricevuta grezza: su una rete OP Stack porta anche la componente di
// pubblicazione dei dati sulla rete sottostante (l1Fee), che viem non espone
// senza i formattatori della catena. Il cliente la paga insieme
// all'esecuzione: senza, il costo di rete sarebbe un limite inferiore.
async function ricevuta(txHash) {
  return client.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
}

function costoDaRicevuta(r) {
  const usato = BigInt(r.gasUsed);
  const prezzo = BigInt(r.effectiveGasPrice ?? 0);
  const l1 = r.l1Fee ? BigInt(r.l1Fee) : 0n;
  return {
    gasUsato: usato.toString(),
    gasPrezzo: prezzo.toString(),
    costoGas: formatUnits(usato * prezzo, 18),
    l1Fee: l1.toString(),
    costoTotale: formatUnits(usato * prezzo + l1, 18),
    txIndex: Number(BigInt(r.transactionIndex ?? 0)),
  };
}

async function osserva(daBlocco, aBlocco) {
  // I provider RPC pubblici limitano l'ampiezza dell'intervallo interrogabile,
  // quindi si procede a finestre anziche' in una sola richiesta; e si salva
  // l'avanzamento a ogni finestra, cosi' che un recupero lungo interrotto a
  // meta' non ricominci da capo.
  for (let inizio = daBlocco; inizio <= aBlocco; inizio += MAX_BLOCK_SPAN) {
    const fine = inizio + MAX_BLOCK_SPAN - 1n > aBlocco ? aBlocco : inizio + MAX_BLOCK_SPAN - 1n;
    const logs = await client.getLogs({ address: FORWARDER, event: orderPaid, fromBlock: inizio, toBlock: fine });

    for (const log of logs) {
      const k = chiave(log);
      if (notificate.has(k) || inAttesa.has(k)) continue;

      // t1 e' l'ora del blocco che contiene la transazione, non quella in cui
      // questo servizio l'ha vista: la seconda dipende dall'intervallo di
      // sondaggio e falserebbe la latenza misurata.
      const t1 = await istanteBlocco(log.blockNumber);
      let costo = { gasUsato: '', gasPrezzo: '', costoGas: '', l1Fee: '', costoTotale: '', txIndex: Number(log.transactionIndex ?? 0) };
      try {
        const r = await ricevuta(log.transactionHash);
        if (r) costo = costoDaRicevuta(r);
      } catch {
        // Il costo e' un dato di misura, non una condizione di funzionamento:
        // se manca si prosegue, il pagamento resta valido.
      }

      inAttesa.set(k, {
        orderRef: log.args.orderRef,
        payer: log.args.payer,
        valore: log.args.amount,
        blocco: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        t1,
        ...costo,
      });
      console.log(`[VISTO]      ordine ${log.args.orderRef.slice(0, 10)} | ${formatUnits(log.args.amount, DECIMALS)} EURe | blocco ${log.blockNumber}`);
    }

    stato.ultimoBlocco = fine;
    salva();
  }
}

/// Ultimo blocco che soddisfa il criterio di conferma configurato, insieme
/// all'istante da attribuire al marcatore t2.
///
/// Con le conferme l'istante e' l'ora del blocco che porta la transazione alla
/// profondita' richiesta. Con le etichette non esiste un blocco equivalente:
/// la testa etichettata porta l'ora in cui fu prodotta, minuti nel passato,
/// mentre cio' che conta e' l'istante in cui il criterio risulta soddisfatto,
/// quantizzato all'intervallo di sondaggio.
async function testaFinale(testa) {
  if ('confirmations' === FINALITY_MODE) {
    return { numero: testa - CONFIRMATIONS, istante: null };
  }
  const blocco = await client.getBlock({ blockTag: FINALITY_MODE });
  return { numero: blocco.number, istante: Date.now() / 1000 };
}

/// Prima di notificare, la transazione deve essere ancora dove l'abbiamo
/// vista. Un blocco non ancora ancorato alla rete sottostante puo' essere
/// sostituito dal sequencer: l'evento decade se la transazione e' sparita,
/// e viene riposizionato se e' stata inclusa in un altro blocco. Senza questo
/// controllo un pagamento decaduto verrebbe notificato, fatturato e
/// riscattato: esattamente lo scenario che il criterio di conferma esiste per
/// escludere.
async function ancoraCanonico(k, p) {
  const r = await ricevuta(p.txHash);
  if (!r || BigInt(r.status ?? 0) !== 1n) {
    console.error(`[DECADUTO]   ordine ${p.orderRef.slice(0, 10)}: transazione ${p.txHash.slice(0, 10)} non piu' nella catena`);
    inAttesa.delete(k);
    salva();
    return false;
  }
  if (r.blockHash.toLowerCase() !== String(p.blockHash).toLowerCase()) {
    const nuovo = BigInt(r.blockNumber);
    console.error(`[SPOSTATO]   ordine ${p.orderRef.slice(0, 10)}: dal blocco ${p.blocco} al blocco ${nuovo}, attesa riavviata`);
    p.blocco = nuovo;
    p.blockHash = r.blockHash;
    p.t1 = await istanteBlocco(nuovo);
    Object.assign(p, costoDaRicevuta(r));
    salva();
    return false;
  }
  return true;
}

async function confermaEnotifica(testa) {
  if (inAttesa.size === 0) return;

  const finale = await testaFinale(testa);

  for (const [k, p] of inAttesa) {
    if (p.blocco > finale.numero) continue;
    if (!(await ancoraCanonico(k, p))) continue;

    const importo = formatUnits(p.valore, DECIMALS);

    // t2: l'incasso soddisfa il criterio di conferma.
    const t2 = null !== finale.istante
      ? finale.istante
      : await istanteBlocco(p.blocco + CONFIRMATIONS);

    const esito = await notificaPagamento({
      chainId: CHAIN_ID,
      orderRef: p.orderRef,
      txHash: p.txHash,
      logIndex: p.logIndex,
      importo,
      payer: p.payer,
      blocco: p.blocco,
      blockHash: p.blockHash,
      txIndex: p.txIndex,
      conferme: 'confirmations' === FINALITY_MODE ? Number(CONFIRMATIONS) : 0,
      criterio: FINALITY_MODE,
      t1: p.t1,
      t2,
      gasUsato: p.gasUsato,
      gasPrezzo: p.gasPrezzo,
      costoGas: p.costoGas,
      l1Fee: p.l1Fee,
      costoTotale: p.costoTotale,
    });

    if (!esito.ok) {
      console.error(`[NOTIFICA]   fallita per ${p.orderRef.slice(0, 10)}: ${esito.dettaglio}`);
      if (esito.definitivo) {
        // Un errore definitivo non migliora riprovando: il pagamento resta
        // registrato come orfano, perche' e' denaro arrivato all'esercente
        // che nessun ordine reclama e che va restituito a mano.
        stato.orfani.push({ chiave: k, orderRef: p.orderRef, payer: p.payer, importo, txHash: p.txHash, motivo: esito.dettaglio, ora: new Date().toISOString() });
        console.error(`[ORFANO]     ${importo} EURe da ${p.payer} con riferimento ${p.orderRef.slice(0, 10)}: nessun ordine corrispondente, da restituire`);
        notificate.add(k);
        inAttesa.delete(k);
        salva();
      }
      continue;
    }

    console.log(`[CONFERMATO] ordine ${p.orderRef.slice(0, 10)} | ${importo} EURe | ${'confirmations' === FINALITY_MODE ? `profondità ${testa - p.blocco} blocchi` : `criterio ${FINALITY_MODE}, ${testa - p.blocco} blocchi di ritardo`}`);
    notificate.add(k);
    inAttesa.delete(k);

    // Un duplicato e' un evento che il plugin conosceva gia': il riscatto,
    // se dovuto, e' stato disposto da chi lo ha notificato la prima volta.
    const duplicato = esito.risposta?.status === 'duplicate';
    if (REDEEM_ENABLED && !duplicato && !stato.riscatti[k]) {
      stato.riscatti[k] = { orderRef: p.orderRef, importo, tentativi: 0, prossimo: 0, ordineId: null, stato: 'da_disporre' };
    }
    salva();
  }

  if (REDEEM_ENABLED) await gestisciRiscatti(true);
}

/// Dispone i riscatti in attesa e segue quelli in corso fino a uno stato
/// terminale. Lo stato vive nel file: un riavvio riprende da dove era.
let ultimoGiroRiscatti = 0;
async function gestisciRiscatti(subito = false) {
  const adesso = Date.now();
  if (!subito && adesso - ultimoGiroRiscatti < RISCATTO_POLL_MS) return;
  ultimoGiroRiscatti = adesso;

  if (!configurazioneRimborsoCompleta()) return;

  for (const [k, r] of Object.entries(stato.riscatti)) {
    if (r.concluso) continue;
    if (r.prossimo > adesso) continue;

    if (!r.ordineId) {
      await disponi(k, r);
    } else {
      await segui(k, r);
    }
  }
}

async function disponi(k, r) {
  const rif = r.orderRef.slice(0, 10);
  try {
    // t4 del protocollo: l'istante in cui il riscatto viene disposto, rilevato
    // al primo tentativo e prima della chiamata, cosi' la latenza di rete
    // dell'emittente ricade nel regolamento e non sparisce dalla misura.
    r.t4 = r.t4 ?? Date.now() / 1000;
    r.tentativi += 1;
    const ordine = await disponiRimborso(r.importo, r.orderRef);
    r.ordineId = ordine.id;
    r.stato = ordine.state ?? 'placed';
    r.prossimo = Date.now() + RISCATTO_POLL_MS;
    salva();
    console.log(`[RISCATTO]   disposto per ${rif}: ordine ${ordine.id}, stato ${r.stato}`);
    await notificaRimborso({ orderRef: r.orderRef, stato: r.stato, ordineId: r.ordineId, t4: r.t4 });
  } catch (err) {
    const transitorio = err.transitorio !== false;
    r.ultimoErrore = (err.message ?? String(err)).slice(0, 300);
    if (transitorio && r.tentativi < RISCATTO_BACKOFF_MS.length) {
      r.prossimo = Date.now() + RISCATTO_BACKOFF_MS[Math.min(r.tentativi - 1, RISCATTO_BACKOFF_MS.length - 1)];
      console.error(`[RISCATTO]   fallito per ${rif} (tentativo ${r.tentativi}), riprovo fra ${Math.round((r.prossimo - Date.now()) / 1000)} s: ${r.ultimoErrore}`);
    } else {
      // Esaurito o definitivo: l'esercente deve saperlo, perche' gli euro
      // tokenizzati restano sull'indirizzo di incasso.
      r.stato = 'failed';
      r.concluso = Date.now();
      console.error(`[RISCATTO]   abbandonato per ${rif}: ${r.ultimoErrore}`);
      await notificaRimborso({ orderRef: r.orderRef, stato: 'failed', motivo: r.ultimoErrore, t4: r.t4 });
    }
    salva();
  }
}

async function segui(k, r) {
  const rif = r.orderRef.slice(0, 10);
  try {
    const o = await statoRimborso(r.ordineId);
    const esito = esitoOrdine(o);
    if (!esito) {
      r.stato = o.state ?? r.stato;
      r.prossimo = Date.now() + RISCATTO_POLL_MS;
      salva();
      return;
    }
    r.stato = esito.stato;
    r.motivo = esito.motivo;
    r.concluso = Date.now();
    salva();
    console.log(`[RISCATTO]   ${rif} concluso: ${esito.stato}${esito.motivo ? ` (${esito.motivo})` : ''}`);
    await notificaRimborso({ orderRef: r.orderRef, stato: esito.stato, ordineId: r.ordineId, motivo: esito.motivo, t5: esito.t5 });
  } catch (err) {
    r.prossimo = Date.now() + RISCATTO_POLL_MS * 4;
    r.ultimoErrore = (err.message ?? String(err)).slice(0, 300);
    salva();
    console.error(`[RISCATTO]   esito di ${rif} non rilevato: ${r.ultimoErrore}`);
  }
}

/// Verifiche di avvio: la configurazione del plugin deve coincidere con
/// quella del servizio, l'indirizzo di incasso non deve essere in lista nera
/// presso il validatore del token e l'IBAN deve risultare collegato.
async function verificheAvvio() {
  const cfg = await leggiConfigurazione();
  if (cfg.ok) {
    const c = cfg.config;
    if (!FINALITY_MODE_ENV && CRITERI.includes(c.finality_mode)) FINALITY_MODE = c.finality_mode;
    if (CONFIRMATIONS_ENV === null && Number(c.confirmations) > 0) CONFIRMATIONS = BigInt(c.confirmations);
    if (CHAIN_ID && Number(c.chain_id) && Number(c.chain_id) !== CHAIN_ID) {
      console.error(`Il plugin e' configurato per la rete ${c.chain_id} (${c.chain}), il servizio osserva la rete ${CHAIN_ID}: mi fermo.`);
      process.exit(1);
    }
    if (c.forwarder && getAddress(c.forwarder) !== FORWARDER) {
      console.error(`Il plugin indica il contratto di inoltro ${c.forwarder}, il servizio osserva ${FORWARDER}: mi fermo.`);
      process.exit(1);
    }
  } else {
    console.error(`[AVVIO]      configurazione del plugin non leggibile (${cfg.dettaglio}): uso ambiente e valori predefiniti`);
  }
  if (POLL_MS_ENV === null) POLL_MS = 'confirmations' === FINALITY_MODE ? 5000 : 30000;

  if (TOKEN_ADDRESS && MERCHANT_ADDRESS) {
    try {
      const validatore = await client.readContract({
        address: TOKEN_ADDRESS,
        abi: [parseAbiItem('function validator() view returns (address)')],
        functionName: 'validator',
      });
      const bandito = await client.readContract({
        address: validatore,
        abi: [parseAbiItem('function isBan(address) view returns (bool)')],
        functionName: 'isBan',
        args: [getAddress(MERCHANT_ADDRESS)],
      });
      if (bandito) console.error('[AVVIO]      ATTENZIONE: l\'indirizzo di incasso risulta in lista nera presso il validatore del token: i pagamenti arriveranno ma il riscatto non sara\' possibile.');
      else console.log('[AVVIO]      indirizzo di incasso non in lista nera presso il validatore del token');
    } catch (err) {
      console.error(`[AVVIO]      verifica della lista nera non riuscita: ${err.shortMessage ?? err.message}`);
    }
  }

  if (REDEEM_ENABLED && configurazioneRimborsoCompleta()) {
    try {
      const ok = await ibanCollegato();
      if (ok) console.log('[AVVIO]      IBAN collegato all\'indirizzo di incasso sulla rete configurata');
      else console.error('[AVVIO]      ATTENZIONE: l\'IBAN configurato non risulta collegato all\'indirizzo di incasso sulla rete in uso: i riscatti verranno respinti.');
    } catch (err) {
      console.error(`[AVVIO]      verifica del collegamento IBAN non riuscita: ${err.message}`);
    }
  }
}

async function main() {
  await verificheAvvio();

  const testa = await client.getBlockNumber();
  let ultimo = stato.ultimoBlocco ?? START_BLOCK ?? testa;
  // Gli eventi in attesa persistiti hanno la precedenza: si riparte da prima
  // del piu' antico, cosi' che l'osservazione li ritrovi coerenti con la catena.
  for (const p of inAttesa.values()) {
    if (p.blocco - 1n < ultimo) ultimo = p.blocco - 1n;
  }

  const criterio = 'confirmations' === FINALITY_MODE ? `${CONFIRMATIONS} conferme` : `etichetta ${FINALITY_MODE}`;
  console.log(`Watcher avviato. Contratto ${FORWARDER}, conferma per ${criterio}, sondaggio ogni ${POLL_MS} ms.`);
  console.log(`Ripartenza dal blocco ${ultimo} (testa ${testa}), ${notificate.size} eventi già notificati, ${inAttesa.size} in attesa, ${stato.orfani.length} orfani, ${Object.values(stato.riscatti).filter((r) => !r.concluso).length} riscatti in corso.`);
  if (REDEEM_ENABLED && !configurazioneRimborsoCompleta()) {
    console.log('Riscatto automatico abilitato ma non configurato: i pagamenti verranno solo notificati.');
  }

  let ultimoBattito = 0;
  let attesaErrore = POLL_MS;
  for (;;) {
    try {
      const testa = await client.getBlockNumber();
      if (testa > ultimo) {
        await osserva(ultimo + 1n, testa);
        ultimo = testa;
      }
      await confermaEnotifica(testa);
      if (REDEEM_ENABLED) await gestisciRiscatti();
      attesaErrore = POLL_MS;

      if (Date.now() - ultimoBattito > 60_000) {
        ultimoBattito = Date.now();
        stato.heartbeat = { ora: new Date().toISOString(), testa: testa.toString(), ultimo: ultimo.toString(), inAttesa: inAttesa.size };
        await heartbeat({ testa: Number(testa), ultimo: Number(ultimo), in_attesa: inAttesa.size, criterio: FINALITY_MODE, chain_id: CHAIN_ID });
      }
    } catch (err) {
      // Un guasto transitorio della rete o del provider non deve terminare il
      // servizio: si registra e si riprova, diradando i tentativi finche' il
      // guasto persiste, per non saturare un provider che gia' rifiuta.
      console.error(`[ERRORE]     ${err.shortMessage ?? err.message ?? err} (riprovo fra ${Math.round(attesaErrore / 1000)} s)`);
      await new Promise((r) => setTimeout(r, attesaErrore));
      attesaErrore = Math.min(attesaErrore * 2, 60_000);
      continue;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
