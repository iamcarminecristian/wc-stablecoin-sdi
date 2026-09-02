// Stato persistente del servizio (RNF-03).
//
// Contiene cio' che serve a ripartire senza perdere nulla e senza ripetere
// nulla: l'ultimo blocco elaborato, gli eventi visti ma non ancora confermati,
// le chiavi degli eventi gia' notificati, i riscatti disposti o da disporre e
// gli eventi orfani, cioe' pagamenti che nessun ordine del negozio reclama.
//
// Gli eventi in attesa vanno persistiti: con il criterio 'finalized' la
// finestra fra osservazione e conferma dura una ventina di minuti, e un
// riavvio in quella finestra, senza persistenza, li perderebbe per sempre,
// perche' il blocco che li contiene risulta gia' elaborato.
//
// La scrittura passa da un file temporaneo, sincronizzato su disco, e da una
// rename atomica: un'interruzione a meta' salvataggio lascia lo stato
// precedente integro anziche' un file troncato.
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';

// Oltre questa soglia le chiavi piu' vecchie vengono dimenticate: sono eventi
// sepolti sotto migliaia di blocchi, che nessuna riorganizzazione puo' piu'
// riproporre, e tenerle farebbe crescere il file senza limite.
const MAX_NOTIFICATE = 5000;
const MAX_ORFANI = 500;

// I riscatti conclusi restano per un giorno, poi si dimenticano: l'esito e'
// gia' stato comunicato al plugin, che ne conserva la traccia sull'ordine.
const RITENZIONE_RISCATTI_MS = 24 * 60 * 60 * 1000;

const vuoto = () => ({
  ultimoBlocco: null,
  notificate: [],
  inAttesa: {},
  riscatti: {},
  orfani: [],
  heartbeat: null,
});

export function caricaStato(file) {
  if (!existsSync(file)) return vuoto();
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const inAttesa = {};
    for (const [k, p] of Object.entries(s.inAttesa ?? {})) {
      inAttesa[k] = { ...p, valore: BigInt(p.valore), blocco: BigInt(p.blocco) };
    }
    return {
      ultimoBlocco: s.ultimoBlocco != null ? BigInt(s.ultimoBlocco) : null,
      notificate: Array.isArray(s.notificate) ? s.notificate : [],
      inAttesa,
      riscatti: s.riscatti && typeof s.riscatti === 'object' ? s.riscatti : {},
      orfani: Array.isArray(s.orfani) ? s.orfani : [],
      heartbeat: s.heartbeat ?? null,
    };
  } catch (err) {
    // Uno stato illeggibile non deve impedire l'avvio, ma va detto: si
    // riparte dalla testa della catena e gli eventi in mezzo si perdono.
    console.error(`[STATO] file illeggibile (${err.message}), riparto da zero`);
    return vuoto();
  }
}

export function salvaStato(file, stato) {
  const adesso = Date.now();
  const riscatti = {};
  for (const [k, r] of Object.entries(stato.riscatti ?? {})) {
    if (r.concluso && adesso - r.concluso > RITENZIONE_RISCATTI_MS) continue;
    riscatti[k] = r;
  }
  const inAttesa = {};
  for (const [k, p] of Object.entries(stato.inAttesa ?? {})) {
    inAttesa[k] = { ...p, valore: p.valore.toString(), blocco: p.blocco.toString() };
  }
  const serializzato = JSON.stringify(
    {
      ultimoBlocco: stato.ultimoBlocco != null ? stato.ultimoBlocco.toString() : null,
      notificate: stato.notificate.slice(-MAX_NOTIFICATE),
      inAttesa,
      riscatti,
      orfani: (stato.orfani ?? []).slice(-MAX_ORFANI),
      heartbeat: stato.heartbeat ?? null,
    },
    null,
    2
  );
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, serializzato, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
