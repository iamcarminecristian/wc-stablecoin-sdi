<?php
/**
 * Orchestrazione della fatturazione elettronica (RF-06, RF-07, §4.5).
 *
 * La trasmissione non avviene durante la richiesta che conferma il pagamento:
 * dipende da un servizio esterno e i suoi tempi non devono ricadere né sul
 * cliente né sul servizio di rilevamento, che attende la risposta. Il lavoro
 * è affidato ad Action Scheduler, la coda che WooCommerce già include, e
 * ritentato con attesa crescente finché la causa resta transitoria.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Fatturazione {

	const AZIONE_TRASMETTI = 'wcsdi_trasmetti_fattura';
	const AZIONE_RICEVUTE  = 'wcsdi_verifica_ricevute';
	const GRUPPO           = 'wc-stablecoin-sdi';

	/** Oltre questo numero di tentativi il caso passa all'esercente. */
	const MAX_TENTATIVI = 6;

	/** Attese fra i tentativi, in secondi: un minuto, poi via via più rade. */
	const BACKOFF = array( 60, 300, 900, 3600, 10800, 21600 );

	/** Per quanto si continua a chiedere notizie di una fattura trasmessa. */
	const MAX_VERIFICHE = 48;

	public static function init() {
		add_action( self::AZIONE_TRASMETTI, array( __CLASS__, 'trasmetti' ), 10, 1 );
		add_action( self::AZIONE_RICEVUTE, array( __CLASS__, 'verifica_ricevute' ), 10, 1 );
	}

	/**
	 * Mette in coda la fatturazione dell'ordine.
	 *
	 * L'accodamento è idempotente: se un'azione per lo stesso ordine è già in
	 * attesa, non se ne aggiunge una seconda. Serve perché la conferma di
	 * pagamento può arrivare più volte, per esempio a fronte di un incasso in
	 * più trasferimenti (RNF-03).
	 */
	public static function accoda( $order_id ) {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return; // Action Scheduler assente: WooCommerce non è attivo.
		}

		$order = wc_get_order( $order_id );
		if ( ! $order || '' !== (string) $order->get_meta( '_wcsdi_fattura_uuid' ) ) {
			return; // Già trasmessa.
		}

		// L'azione porta come argomento il solo identificativo dell'ordine.
		// Il numero di tentativi vive nei metadati, non fra gli argomenti,
		// perché as_has_scheduled_action riconosce un'azione già in coda solo
		// se gli argomenti coincidono esattamente: con il contatore fra gli
		// argomenti il controllo non troverebbe mai il ritentativo in attesa e
		// ogni conferma di pagamento accoderebbe un duplicato.
		if ( as_has_scheduled_action( self::AZIONE_TRASMETTI, array( 'order_id' => (int) $order_id ), self::GRUPPO ) ) {
			return;
		}

		as_schedule_single_action(
			time(),
			self::AZIONE_TRASMETTI,
			array( 'order_id' => (int) $order_id ),
			self::GRUPPO
		);
	}

	/**
	 * Compone e trasmette la fattura. Invocata da Action Scheduler.
	 */
	public static function trasmetti( $order_id ) {
		$order = wc_get_order( (int) $order_id );
		if ( ! $order ) {
			return;
		}
		if ( '' !== (string) $order->get_meta( '_wcsdi_fattura_uuid' ) ) {
			return; // Trasmessa da un tentativo precedente andato a buon fine.
		}

		$tentativo = (int) $order->get_meta( '_wcsdi_fattura_tentativi' ) + 1;
		$order->update_meta_data( '_wcsdi_fattura_tentativi', $tentativo );
		$order->save();

		$config = self::configurazione_cedente();
		if ( is_wp_error( $config ) ) {
			// Configurazione incompleta: riprovare non serve, deve
			// intervenire l'esercente.
			self::segnala( $order, $config->get_error_message(), false );
			return;
		}

		$numero = (int) $order->get_meta( '_wcsdi_fattura_numero' );
		if ( ! $numero ) {
			// Il numero si assegna una volta sola: un ritentativo non deve
			// consumare un altro progressivo e lasciare un buco nella serie.
			$numero = WCSDI_Fattura::prossimo_numero( (int) gmdate( 'Y' ) );
			$order->update_meta_data( '_wcsdi_fattura_numero', $numero );
			$order->save();
		}

		try {
			$xml    = WCSDI_Fattura::componi( $order, $config, $numero );
			$client = new WCSDI_SdI_Client( $config['base_url'], $config['token'] );
			$esito  = $client->trasmetti( $xml );

			$order->update_meta_data( '_wcsdi_fattura_uuid', $esito['uuid'] );
			$order->update_meta_data( '_wcsdi_fattura_stato', $esito['marking'] );
			$order->add_order_note( sprintf(
				/* translators: 1: numero fattura, 2: identificativo, 3: stato */
				__( 'Fattura %1$s trasmessa al SdI. Identificativo %2$s, stato %3$s.', 'wc-stablecoin-sdi' ),
				$numero,
				$esito['uuid'],
				$esito['marking']
			) );
			$order->save();

			self::accoda_verifica( (int) $order_id, 0 );

		} catch ( WCSDI_SdI_Exception $e ) {
			self::gestisci_errore( $order, $e, $tentativo );
		}
	}

	/**
	 * Rilegge lo stato della fattura fino a un esito definitivo (RF-07).
	 */
	public static function verifica_ricevute( $order_id ) {
		$order = wc_get_order( (int) $order_id );
		if ( ! $order ) {
			return;
		}

		$verifica = (int) $order->get_meta( '_wcsdi_sdi_verifiche' ) + 1;
		$order->update_meta_data( '_wcsdi_sdi_verifiche', $verifica );

		$uuid = (string) $order->get_meta( '_wcsdi_fattura_uuid' );
		if ( '' === $uuid ) {
			return;
		}

		$config = self::configurazione_cedente();
		if ( is_wp_error( $config ) ) {
			return;
		}

		try {
			$client = new WCSDI_SdI_Client( $config['base_url'], $config['token'] );
			$stato  = $client->stato( $uuid );
		} catch ( WCSDI_SdI_Exception $e ) {
			$order->save();
			if ( $e->e_transitorio() && $verifica < self::MAX_VERIFICHE ) {
				self::accoda_verifica( (int) $order_id, $verifica );
			}
			return;
		}

		$precedente = (string) $order->get_meta( '_wcsdi_fattura_stato' );
		if ( $stato['marking'] !== $precedente && '' !== $stato['marking'] ) {
			$order->update_meta_data( '_wcsdi_fattura_stato', $stato['marking'] );
			$order->add_order_note( sprintf(
				/* translators: %s: stato della fattura presso il SdI */
				__( 'Stato della fattura presso il SdI: %s.', 'wc-stablecoin-sdi' ),
				$stato['marking']
			) );
		}

		$notifiche = $stato['notifications'];
		if ( empty( $notifiche ) ) {
			try {
				$notifiche = $client->notifiche( $uuid );
			} catch ( WCSDI_SdI_Exception $e ) {
				// L'endpoint dedicato e' una conferma, non la fonte primaria: se
				// non risponde si prosegue con quanto gia' letto.
				$notifiche = array();
			}
		}

		foreach ( $notifiche as $notifica ) {
			self::registra_notifica( $order, $notifica );
		}

		$order->save();

		// Consegna e mancata consegna chiudono il ciclo: la fattura è
		// comunque nella disponibilità del destinatario. Lo scarto lo chiude
		// in senso opposto e richiede una correzione, che resta all'esercente.
		$definitivi = WCSDI_Misure::MARKING_DEFINITIVI;
		if ( in_array( $stato['marking'], $definitivi, true ) ) {
			return;
		}

		if ( $verifica < self::MAX_VERIFICHE ) {
			self::accoda_verifica( (int) $order_id, $verifica );
		}
	}

	private static function registra_notifica( WC_Order $order, $notifica ) {
		$viste = (array) $order->get_meta( '_wcsdi_sdi_notifiche' );
		$firma = is_array( $notifica )
			? md5( wp_json_encode( $notifica ) )
			: md5( (string) $notifica );

		if ( in_array( $firma, $viste, true ) ) {
			return;
		}
		$viste[] = $firma;
		$order->update_meta_data( '_wcsdi_sdi_notifiche', $viste );

		$tipo = is_array( $notifica ) && isset( $notifica['type'] ) ? $notifica['type'] : 'notifica';
		$order->add_order_note( sprintf(
			/* translators: 1: tipo di notifica, 2: contenuto */
			__( 'Notifica dal SdI (%1$s): %2$s', 'wc-stablecoin-sdi' ),
			$tipo,
			wp_json_encode( $notifica )
		) );
	}

	private static function gestisci_errore( WC_Order $order, WCSDI_SdI_Exception $e, $tentativo ) {
		if ( ! $e->e_transitorio() || $tentativo >= self::MAX_TENTATIVI ) {
			self::segnala( $order, $e->getMessage(), $e->e_transitorio() );
			return;
		}

		$attesa = self::BACKOFF[ min( $tentativo - 1, count( self::BACKOFF ) - 1 ) ];
		$order->add_order_note( sprintf(
			/* translators: 1: numero tentativo, 2: secondi, 3: errore */
			__( 'Trasmissione non riuscita (tentativo %1$d), nuovo tentativo fra %2$d secondi. %3$s', 'wc-stablecoin-sdi' ),
			$tentativo,
			$attesa,
			$e->getMessage()
		) );
		$order->save();

		as_schedule_single_action(
			time() + $attesa,
			self::AZIONE_TRASMETTI,
			array( 'order_id' => $order->get_id() ),
			self::GRUPPO
		);
	}

	/**
	 * Porta il caso all'attenzione dell'esercente: la fatturazione si è
	 * fermata e nessun automatismo la sbloccherà.
	 */
	private static function segnala( WC_Order $order, $messaggio, $transitorio ) {
		$order->update_meta_data( '_wcsdi_fattura_stato', 'errore' );
		$order->update_meta_data( '_wcsdi_fattura_errore', $messaggio );
		$order->add_order_note( sprintf(
			/* translators: %s: descrizione dell'errore */
			__( 'Fatturazione ferma, serve un intervento manuale: %s', 'wc-stablecoin-sdi' ),
			$messaggio
		) );
		$order->save();

		/**
		 * Consente di notificare l'esercente per altre vie.
		 *
		 * @param WC_Order $order       Ordine interessato.
		 * @param string   $messaggio   Descrizione dell'errore.
		 * @param bool     $transitorio Se la causa era transitoria ma i tentativi sono esauriti.
		 */
		do_action( 'wcsdi_fatturazione_fallita', $order, $messaggio, $transitorio );
	}

	/**
	 * Intervallo prima della prossima interrogazione, in secondi.
	 *
	 * La sequenza deve coprire piu' di cinque giorni: l'Agenzia delle Entrate
	 * dichiara che il Sistema di Interscambio effettua i controlli e la
	 * consegna «in tempi che possono variare da pochi minuti ad un massimo di
	 * 5 giorni» quando il volume in lavorazione e' elevato. Una sequenza piu'
	 * corta smetterebbe di guardare prima che il destinatario abbia finito, e
	 * l'assenza di ricevute verrebbe scambiata per un esito.
	 *
	 * Con MAX_VERIFICHE tentativi la sequenza copre poco piu' di nove giorni.
	 */
	private static function attesa_verifica( $eseguite ) {
		if ( $eseguite < 3 ) {
			return 300;    // primo quarto d'ora: e' qui che arriva lo scarto
		}
		if ( $eseguite < 12 ) {
			return 3600;   // prime nove ore
		}
		return 21600;      // poi ogni sei ore
	}

	private static function accoda_verifica( $order_id, $eseguite ) {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return;
		}
		if ( as_has_scheduled_action( self::AZIONE_RICEVUTE, array( 'order_id' => (int) $order_id ), self::GRUPPO ) ) {
			return;
		}
		$attesa = self::attesa_verifica( $eseguite );
		as_schedule_single_action(
			time() + $attesa,
			self::AZIONE_RICEVUTE,
			array( 'order_id' => (int) $order_id ),
			self::GRUPPO
		);
	}

	/**
	 * Dati del cedente e credenziali, dalla configurazione del gateway.
	 * Pubblica perché serve anche alla nota di credito.
	 *
	 * @return array|WP_Error
	 */
	public static function configurazione_cedente() {
		$opzioni = (array) get_option( 'woocommerce_wcsdi_eure_settings', array() );
		$leggi   = function ( $chiave ) use ( $opzioni ) {
			return isset( $opzioni[ $chiave ] ) ? trim( (string) $opzioni[ $chiave ] ) : '';
		};

		// Il fornitore accetta indifferentemente partita IVA o codice fiscale,
		// purché coincida con quello registrato nella configurazione azienda.
		$fiscal_id = $leggi( 'cedente_piva' );
		if ( '' === $fiscal_id ) {
			$fiscal_id = $leggi( 'cedente_cf' );
		}

		$obbligatori = array(
			'openapi_token'         => __( 'token del fornitore SdI', 'wc-stablecoin-sdi' ),
			'cedente_denominazione' => __( 'denominazione del cedente', 'wc-stablecoin-sdi' ),
			'cedente_indirizzo'     => __( 'indirizzo del cedente', 'wc-stablecoin-sdi' ),
			'cedente_cap'           => __( 'CAP del cedente', 'wc-stablecoin-sdi' ),
			'cedente_comune'        => __( 'comune del cedente', 'wc-stablecoin-sdi' ),
			'cedente_provincia'     => __( 'provincia del cedente', 'wc-stablecoin-sdi' ),
		);

		$mancanti = array();
		foreach ( $obbligatori as $chiave => $etichetta ) {
			if ( '' === $leggi( $chiave ) ) {
				$mancanti[] = $etichetta;
			}
		}
		if ( '' === $fiscal_id ) {
			$mancanti[] = __( 'partita IVA o codice fiscale del cedente', 'wc-stablecoin-sdi' );
		}

		if ( ! empty( $mancanti ) ) {
			return new WP_Error(
				'wcsdi_config_incompleta',
				sprintf(
					/* translators: %s: elenco dei dati mancanti */
					__( 'Configurazione della fatturazione incompleta, mancano: %s', 'wc-stablecoin-sdi' ),
					implode( ', ', $mancanti )
				)
			);
		}

		$base = $leggi( 'openapi_base_url' );

		return array(
			'base_url'      => '' !== $base ? $base : 'https://test.sdi.openapi.it',
			'token'         => $leggi( 'openapi_token' ),
			'fiscal_id'     => $fiscal_id,
			'denominazione' => $leggi( 'cedente_denominazione' ),
			'regime'        => '' !== $leggi( 'cedente_regime' ) ? $leggi( 'cedente_regime' ) : 'RF01',
			'sede'          => array(
				'indirizzo' => $leggi( 'cedente_indirizzo' ),
				'cap'       => $leggi( 'cedente_cap' ),
				'comune'    => $leggi( 'cedente_comune' ),
				'provincia' => $leggi( 'cedente_provincia' ),
				'nazione'   => 'IT',
			),
		);
	}
}
