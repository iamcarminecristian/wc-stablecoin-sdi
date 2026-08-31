<?php
/**
 * Strumentazione per la validazione sperimentale (Capitolo 6).
 *
 * Registra per ogni ordine i marcatori temporali definiti dal protocollo KPI,
 * così che il dataset non debba essere ricostruito a posteriori dai log:
 *
 *   t0  checkout completato, il cliente dispone il pagamento
 *   t1  transazione inclusa in un blocco, prima conferma
 *   t2  finalità raggiunta secondo il criterio configurato
 *   t3  il plugin riconcilia il pagamento con l'ordine
 *   t4  rimborso verso SEPA avviato
 *   t5  euro accreditati sul conto
 *
 * Da questi discendono le due latenze che il protocollo tiene distinte: la
 * conferma dell'incasso lato esercente, che si confronta con l'autorizzazione
 * di una carta, e il regolamento in euro, che si confronta con l'accredito del
 * processore. Confonderle produrrebbe un raffronto scorretto.
 *
 * I tempi sono in UTC con precisione al millesimo. I marcatori on-chain
 * riportano l'ora del blocco, non quella in cui il servizio se ne è accorto:
 * la seconda dipende dall'intervallo di sondaggio e falserebbe la misura.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Misure {

	const META = '_wcsdi_marcatori';

	/** Marcatori previsti dal protocollo, nell'ordine in cui maturano. */
	const MARCATORI = array( 't0', 't1', 't2', 't3', 't4', 't5' );

	/**
	 * Valori di «marking» che il fornitore assegna quando il Sistema di
	 * Interscambio ha chiuso la propria lavorazione con esito positivo: la
	 * fattura è stata consegnata al destinatario oppure, non essendo il canale
	 * disponibile, è stata messa a sua disposizione nell'area riservata. In
	 * entrambi i casi il documento è fiscalmente valido, che è ciò che il KPI
	 * di integrità fiscale misura.
	 *
	 * I nomi sono quelli documentati dal fornitore e usano il trattino, non il
	 * carattere di sottolineatura: scriverli nell'altra forma produce un
	 * confronto sempre falso e un KPI costantemente a zero.
	 * Fonte: console.openapi.com/apis/sdi/documentation.
	 */
	const MARKING_CONSEGNATA = array( 'delivered', 'delivered-pa', 'not-delivered' );

	/** Valori oltre i quali lo stato della fattura non evolve più. */
	const MARKING_DEFINITIVI = array( 'delivered', 'delivered-pa', 'not-delivered', 'rejected' );

	/**
	 * Registra un marcatore, se non già presente.
	 *
	 * Il primo valore vince: una notifica ripetuta o un ritentativo non devono
	 * spostare in avanti un istante già osservato, altrimenti le latenze
	 * risulterebbero più brevi del vero (RNF-03).
	 *
	 * @param WC_Order $order      Ordine interessato.
	 * @param string   $marcatore  Uno fra t0…t5.
	 * @param float    $timestamp  Epoch UNIX con frazione; assente per adesso.
	 */
	public static function segna( WC_Order $order, $marcatore, $timestamp = null ) {
		if ( ! in_array( $marcatore, self::MARCATORI, true ) ) {
			return;
		}

		$marcatori = (array) $order->get_meta( self::META );
		if ( isset( $marcatori[ $marcatore ] ) ) {
			return;
		}

		$marcatori[ $marcatore ] = null !== $timestamp ? (float) $timestamp : microtime( true );
		$order->update_meta_data( self::META, $marcatori );
	}

	/** @return array<string,float> Marcatori registrati sull'ordine. */
	public static function leggi( WC_Order $order ) {
		return (array) $order->get_meta( self::META );
	}

	/**
	 * Riga del dataset per un ordine, secondo lo schema del protocollo.
	 *
	 * Le latenze sono calcolate qui e non in fase di analisi, così che il file
	 * esportato sia già leggibile senza rieseguire alcun calcolo.
	 */
	public static function riga( WC_Order $order ) {
		$m = self::leggi( $order );
		$g = function ( $k ) use ( $m ) {
			return isset( $m[ $k ] ) ? (float) $m[ $k ] : null;
		};
		$delta = function ( $a, $b ) use ( $g ) {
			$x = $g( $a );
			$y = $g( $b );
			return ( null !== $x && null !== $y ) ? round( $y - $x, 3 ) : null;
		};

		$rimborso = (string) $order->get_meta( '_wcsdi_rimborso_stato' );
		$fattura  = (string) $order->get_meta( '_wcsdi_fattura_stato' );

		return array(
			'order_id'          => $order->get_id(),
			'binario'           => 'stablecoin',
			'importo'           => wc_format_decimal( (string) $order->get_total(), 2 ),
			'valuta'            => $order->get_currency(),
			'chain'             => (string) $order->get_meta( '_wcsdi_chain' ),
			// Identificativo numerico della rete osservata. Distingue misure
			// prese su reti diverse, che il solo nome configurato confonde.
			'chain_id'          => (string) $order->get_meta( '_wcsdi_chain_id' ),
			'forwarder'         => (string) $order->get_meta( '_wcsdi_forwarder' ),
			// Numero di conferme richiesto per dichiarare finale il pagamento. La
			// latenza di conferma ne discende direttamente, quindi aggregare misure
			// prese con criteri diversi non avrebbe senso.
			'conferme'          => (string) $order->get_meta( '_wcsdi_conferme' ),
			'tx_hash'           => (string) $order->get_meta( '_wcsdi_tx_hash' ),
			'gas_usato'         => (string) $order->get_meta( '_wcsdi_gas_usato' ),
			'gas_prezzo_wei'    => (string) $order->get_meta( '_wcsdi_gas_prezzo' ),
			'costo_gas_nativo'  => (string) $order->get_meta( '_wcsdi_costo_gas' ),
			't0'                => self::iso( $g( 't0' ) ),
			't1'                => self::iso( $g( 't1' ) ),
			't2'                => self::iso( $g( 't2' ) ),
			't3'                => self::iso( $g( 't3' ) ),
			't4'                => self::iso( $g( 't4' ) ),
			't5'                => self::iso( $g( 't5' ) ),
			// Latenza di conferma dell'incasso: si confronta con
			// l'autorizzazione di una carta, non con il suo accredito.
			'latenza_conferma'  => $delta( 't0', 't2' ),
			'latenza_riconcil'  => $delta( 't0', 't3' ),
			// Latenza di regolamento: si confronta con l'accredito.
			'latenza_regolam'   => $delta( 't0', 't5' ),
			'stato_ordine'      => $order->get_status(),
			'esito'             => self::esito( $order ),
			'categoria_errore'  => (string) $order->get_meta( '_wcsdi_categoria_errore' ),
			'stato_rimborso'    => $rimborso,
			'fattura_numero'    => (string) $order->get_meta( '_wcsdi_fattura_numero' ),
			'fattura_uuid'      => (string) $order->get_meta( '_wcsdi_fattura_uuid' ),
			'fattura_stato'     => $fattura,
			'fattura_accettata' => self::fattura_accettata( $fattura ) ? '1' : '0',
			'imponibile'        => wc_format_decimal( (string) ( (float) $order->get_total() - (float) $order->get_total_tax() ), 2 ),
			'imposta'           => wc_format_decimal( (string) $order->get_total_tax(), 2 ),
			// Una latenza negativa non è un evento fisico: significa che
			// l'orologio del server e quello della catena non concordano. Il
			// protocollo richiede la sincronizzazione NTP, e la riga va
			// scartata dall'analisi anziché passare inosservata fra le altre.
			'anomalia_orologio' => self::anomalia( $delta( 't0', 't2' ), $delta( 't0', 't3' ) ) ? '1' : '0',
		);
	}

	/**
	 * Segnala misure incoerenti con lo scorrere del tempo. Si verificano
	 * quando i due orologi non sono allineati, tipicamente su una catena di
	 * sviluppo che genera i blocchi su richiesta.
	 */
	private static function anomalia( $conferma, $riconciliazione ) {
		foreach ( array( $conferma, $riconciliazione ) as $v ) {
			if ( null !== $v && $v < 0 ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Esito della transazione secondo la tassonomia del protocollo: serve a
	 * calcolare il tasso di errore per categoria e non solo in aggregato.
	 */
	private static function esito( WC_Order $order ) {
		if ( $order->has_status( array( 'processing', 'completed' ) ) ) {
			return 'successo';
		}
		if ( $order->has_status( 'failed' ) ) {
			return 'yes' === (string) $order->get_meta( '_wcsdi_scaduto' ) ? 'scaduto' : 'fallito';
		}
		if ( $order->has_status( 'on-hold' ) ) {
			return 'parziale';
		}
		return 'in_attesa';
	}

	/**
	 * Una fattura si considera accettata quando il Sistema di Interscambio ne
	 * ha attestato la consegna o la messa a disposizione. Lo stato di semplice
	 * trasmissione non basta: sarebbe una misura di ciò che ha fatto il
	 * plugin, non di ciò che ha fatto il destinatario.
	 */
	private static function fattura_accettata( $stato ) {
		return in_array( $stato, self::MARKING_CONSEGNATA, true );
	}

	private static function iso( $timestamp ) {
		if ( null === $timestamp ) {
			return '';
		}
		return gmdate( 'Y-m-d\TH:i:s', (int) $timestamp )
			. sprintf( '.%03dZ', (int) round( ( $timestamp - floor( $timestamp ) ) * 1000 ) );
	}

}
