// Stato persistente del servizio: ultimo blocco elaborato ed eventi gia'
// notificati al plugin. Serve a ripartire senza rileggere l'intera catena e
// senza rinotificare cio' che e' gia' stato preso in carico (RNF-03).
//
// La scrittura passa da un file temporaneo e da una rename, che sui filesystem
// in uso e' atomica: un'interruzione a meta' salvataggio lascia lo stato
// precedente integro anziche' un file troncato.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// Oltre questa soglia le chiavi piu' vecchie vengono dimenticate: sono eventi
// sepolti sotto migliaia di blocchi, che nessuna riorganizzazione puo' piu'
// riproporre, e tenerle farebbe crescere il file senza limite.
const MAX_NOTIFICATE = 5000;

export function caricaStato(file) {
  if (!existsSync(file)) return { ultimoBlocco: null, notificate: [] };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ultimoBlocco: s.ultimoBlocco != null ? BigInt(s.ultimoBlocco) : null,
      notificate: Array.isArray(s.notificate) ? s.notificate : [],
    };
  } catch (err) {
    // Uno stato illeggibile non deve impedire l'avvio, ma va detto: si
    // riparte dalla testa della catena e gli eventi in mezzo si perdono.
    console.error(`[STATO] file illeggibile (${err.message}), riparto da zero`);
    return { ultimoBlocco: null, notificate: [] };
  }
}

export function salvaStato(file, stato) {
  const notificate = stato.notificate.slice(-MAX_NOTIFICATE);
  const serializzato = JSON.stringify(
    {
      ultimoBlocco: stato.ultimoBlocco != null ? stato.ultimoBlocco.toString() : null,
      notificate,
    },
    null,
    2
  );
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializzato, 'utf8');
  renameSync(tmp, file);
}
