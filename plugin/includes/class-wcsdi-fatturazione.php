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
	const MAX_TENTATIVI = 12;

	/**
	 * Attese fra i tentativi, in secondi: un minuto, poi via via più rade fino
	 * a sei ore. La sequenza copre poco più di due giorni: un'indisponibilità
	 * del fornitore di mezza giornata, evento ordinario, non deve portare le
	 * fatture all'intervento manuale, e il termine di legge per la fattura
	 * immediata è di dodici giorni dall'effettuazione (art. 21, c. 4, DPR 633/72).
	 */
	const BACKOFF = array( 60, 300, 900, 3600, 10800, 21600, 21600, 21600, 21600, 21600, 21600 );

	/** Per quanto si continua a chiedere notizie di una fattura trasmessa. */
	const MAX_VERIFICHE = 48;

	/** Stati dai quali l'esercente può disporre una nuova trasmissione. */
	const STATI_RITRASMETTIBILI = array( 'rejected', 'errore' );

	public static function init() {
		add_action( self::AZIONE_TRASMETTI, array( __CLASS__, 'trasmetti' ), 10, 1 );
		add_action( self::AZIONE_RICEVUTE, array( __CLASS__, 'verifica_ricevute' ), 10, 1 );

		// Lo scarto del SdI e l'errore definitivo riaprono la lavorazione: la
		// correzione resta all'esercente, che dispone poi la ritrasmissione
		// dalla scheda dell'ordine (RF-07).
		add_filter( 'woocommerce_order_actions', array( __CLASS__, 'azioni_ordine' ), 10, 2 );
		add_action( 'woocommerce_order_action_wcsdi_ritrasmetti', array( __CLASS__, 'azione_ritrasmetti' ) );

		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			WP_CLI::add_command( 'wcsdi ritrasmetti', array( __CLASS__, 'comando_ritrasmetti' ) );
		}
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

		if ( ! $config['cedente_e_piva'] && '' === (string) $order->get_meta( '_wcsdi_avviso_cedente_cf' ) ) {
			// Il fornitore accetta anche un codice fiscale personale, il
			// Sistema di Interscambio in produzione no: l'identificativo del
			// cedente deve essere una partita IVA presente in Anagrafe
			// Tributaria (controllo 00301). Lo si dice una volta sull'ordine.
			$order->add_order_note( __( 'Il cedente è identificato da un codice fiscale e non da una partita IVA: accettato dal fornitore in ambiente di prova, in produzione il SdI scarterebbe il documento (controllo 00301).', 'wc-stablecoin-sdi' ) );
			$order->update_meta_data( '_wcsdi_avviso_cedente_cf', 'yes' );
			$order->save();
		}

		$numero = (int) $order->get_meta( '_wcsdi_fattura_numero' );
		if ( ! $numero ) {
			// Il numero si assegna una volta sola: un ritentativo non deve
			// consumare un altro progressivo e lasciare un buco nella serie.
			// La serie è quella dell'anno della data del documento.
			$numero = WCSDI_Fattura::prossimo_numero( WCSDI_Fattura::anno_documento( $order ) );
			$order->update_meta_data( '_wcsdi_fattura_numero', $numero );
			$order->save();
		}

		try {
			$xml    = WCSDI_Fattura::componi( $order, $config, $numero );
			$client = new WCSDI_SdI_Client( $config['base_url'], $config['token'] );
			$esito  = $client->trasmetti( $xml );

			$order->update_meta_data( '_wcsdi_fattura_uuid', $esito['uuid'] );
			$order->update_meta_data( '_wcsdi_fattura_stato', $esito['marking'] );
			$order->update_meta_data( '_wcsdi_fattura_trasmessa_il', gmdate( 'c' ) );
			$order->delete_meta_data( '_wcsdi_fattura_errore' );
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
			$order->save();
			return;
		}

		$config = self::configurazione_cedente();
		if ( is_wp_error( $config ) ) {
			$order->save();
			return;
		}

		try {
			$client = new WCSDI_SdI_Client( $config['base_url'], $config['token'] );
			$stato  = $client->stato( $uuid );
		} catch ( WCSDI_SdI_Exception $e ) {
			if ( $e->e_transitorio() && $verifica < self::MAX_VERIFICHE ) {
				$order->save();
				self::accoda_verifica( (int) $order_id, $verifica );
				return;
			}
			// Un errore che non passa da solo (credenziali revocate,
			// identificativo sconosciuto) fermerebbe il ciclo in silenzio: lo
			// stato resterebbe «sent» senza che nulla distingua l'attesa dal
			// guasto. Si annota e si espone all'esercente.
			$order->update_meta_data( '_wcsdi_sdi_verifica_errore', $e->getMessage() );
			$order->add_order_note( sprintf(
				/* translators: %s: descrizione dell'errore */
				__( 'Verifica delle ricevute SdI interrotta: %s', 'wc-stablecoin-sdi' ),
				$e->getMessage()
			) );
			$order->save();
			do_action( 'wcsdi_verifica_fallita', $order, $e->getMessage() );
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
		if ( ! empty( $stato['notice'] ) && (string) $order->get_meta( '_wcsdi_sdi_notice' ) !== (string) $stato['notice'] ) {
			$order->update_meta_data( '_wcsdi_sdi_notice', (string) $stato['notice'] );
			$order->add_order_note( sprintf(
				/* translators: %s: avviso del fornitore */
				__( 'Avviso del fornitore SdI: %s', 'wc-stablecoin-sdi' ),
				(string) $stato['notice']
			) );
		}

		$notifiche = $stato['notifications'];
		// L'endpoint dedicato è una conferma, non la fonte primaria, e ogni
		// lettura ha un costo presso il fornitore: lo si interroga nelle prime
		// verifiche, quando arriva lo scarto, e poi a intervalli.
		if ( empty( $notifiche ) && ( $verifica <= 3 || 0 === $verifica % 6 ) ) {
			try {
				$notifiche = $client->notifiche( $uuid );
			} catch ( WCSDI_SdI_Exception $e ) {
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
			if ( 'rejected' === $stato['marking'] ) {
				do_action( 'wcsdi_fattura_scartata', $order );
			}
			return;
		}

		if ( $verifica < self::MAX_VERIFICHE ) {
			self::accoda_verifica( (int) $order_id, $verifica );
		}
	}

	/**
	 * Riapre la lavorazione di una fattura scartata o ferma per errore e ne
	 * dispone una nuova trasmissione (RF-07). Il numero progressivo resta
	 * quello già assegnato: la fattura scartata si considera non emessa e va
	 * ritrasmessa con lo stesso numero entro cinque giorni dalla notifica.
	 *
	 * @return true|WP_Error
	 */
	public static function ritrasmetti( $order_id ) {
		$order = wc_get_order( (int) $order_id );
		if ( ! $order || 'wcsdi_eure' !== $order->get_payment_method() ) {
			return new WP_Error( 'wcsdi_ordine', __( 'Ordine non trovato o non pagato in EURe.', 'wc-stablecoin-sdi' ) );
		}
		$stato = (string) $order->get_meta( '_wcsdi_fattura_stato' );
		if ( ! in_array( $stato, self::STATI_RITRASMETTIBILI, true ) ) {
			return new WP_Error( 'wcsdi_stato', sprintf(
				/* translators: %s: stato attuale */
				__( 'La fattura è in stato «%s»: si ritrasmette solo dopo uno scarto o un errore.', 'wc-stablecoin-sdi' ),
				'' !== $stato ? $stato : 'assente'
			) );
		}

		$precedente = (string) $order->get_meta( '_wcsdi_fattura_uuid' );
		if ( '' !== $precedente ) {
			$order->update_meta_data( '_wcsdi_fattura_uuid_precedente', $precedente );
		}
		$order->delete_meta_data( '_wcsdi_fattura_uuid' );
		$order->delete_meta_data( '_wcsdi_fattura_errore' );
		$order->delete_meta_data( '_wcsdi_sdi_verifica_errore' );
		$order->update_meta_data( '_wcsdi_fattura_tentativi', 0 );
		$order->update_meta_data( '_wcsdi_sdi_verifiche', 0 );
		$order->update_meta_data( '_wcsdi_fattura_stato', 'da_ritrasmettere' );
		$order->add_order_note( sprintf(
			/* translators: %s: identificativo precedente */
			__( 'Ritrasmissione della fattura disposta dall\'esercente (identificativo precedente: %s).', 'wc-stablecoin-sdi' ),
			'' !== $precedente ? $precedente : '-'
		) );
		$order->save();

		self::accoda( (int) $order_id );
		return true;
	}

	/** Voce «Ritrasmetti fattura al SdI» nel menu delle azioni dell'ordine. */
	public static function azioni_ordine( $azioni, $order = null ) {
		if ( ! $order instanceof WC_Order ) {
			return $azioni;
		}
		if ( 'wcsdi_eure' === $order->get_payment_method()
			&& in_array( (string) $order->get_meta( '_wcsdi_fattura_stato' ), self::STATI_RITRASMETTIBILI, true ) ) {
			$azioni['wcsdi_ritrasmetti'] = __( 'Ritrasmetti la fattura al SdI', 'wc-stablecoin-sdi' );
		}
		return $azioni;
	}

	public static function azione_ritrasmetti( $order ) {
		if ( $order instanceof WC_Order ) {
			$esito = self::ritrasmetti( $order->get_id() );
			if ( is_wp_error( $esito ) ) {
				$order->add_order_note( $esito->get_error_message() );
				$order->save();
			}
		}
	}

	/**
	 * Ritrasmette una fattura scartata o ferma per errore.
	 *
	 * ## OPTIONS
	 *
	 * <order_id>
	 * : Identificativo dell'ordine.
	 */
	public static function comando_ritrasmetti( $args ) {
		$esito = self::ritrasmetti( (int) $args[0] );
		if ( is_wp_error( $esito ) ) {
			WP_CLI::error( $esito->get_error_message() );
		}
		WP_CLI::success( sprintf( 'Fattura dell\'ordine %d riaccodata per la trasmissione.', (int) $args[0] ) );
	}

	private static function registra_notifica( WC_Order $order, $notifica ) {
		$viste = $order->get_meta( '_wcsdi_sdi_notifiche' );
		$viste = is_array( $viste ) ? $viste : array();
		$firma = is_array( $notifica )
			? md5( wp_json_encode( $notifica ) )
			: md5( (string) $notifica );

		if ( in_array( $firma, $viste, true ) ) {
			return;
		}
		$viste[] = $firma;
		$order->update_meta_data( '_wcsdi_sdi_notifiche', $viste );

		// Nella nota vanno tipo, data e identificativo: il contenuto integrale
		// può includere il file della ricevuta e resta nel metadato dedicato.
		$tipo = is_array( $notifica ) && isset( $notifica['type'] ) ? (string) $notifica['type'] : 'notifica';
		$data = is_array( $notifica ) && isset( $notifica['date'] ) ? (string) $notifica['date'] : '';
		$id   = is_array( $notifica ) && isset( $notifica['uuid'] ) ? (string) $notifica['uuid'] : '';
		$order->update_meta_data( '_wcsdi_sdi_notifica_' . substr( $firma, 0, 8 ), wp_json_encode( $notifica ) );
		$order->add_order_note( sprintf(
			/* translators: 1: tipo di notifica, 2: data, 3: identificativo */
			__( 'Notifica dal SdI: %1$s %2$s %3$s', 'wc-stablecoin-sdi' ),
			$tipo,
			$data,
			$id
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
	 * La sequenza deve coprire più di cinque giorni: l'Agenzia delle Entrate
	 * dichiara che il Sistema di Interscambio effettua i controlli e la
	 * consegna «in tempi che possono variare da pochi minuti ad un massimo di
	 * 5 giorni» quando il volume in lavorazione è elevato. Una sequenza più
	 * corta smetterebbe di guardare prima che il destinatario abbia finito, e
	 * l'assenza di ricevute verrebbe scambiata per un esito.
	 *
	 * Con MAX_VERIFICHE tentativi la sequenza copre poco più di nove giorni.
	 */
	private static function attesa_verifica( $eseguite ) {
		if ( $eseguite < 3 ) {
			return 300;    // primo quarto d'ora: è qui che arriva lo scarto
		}
		if ( $eseguite < 12 ) {
			return 3600;   // prime nove ore
		}
		return 21600;      // poi ogni sei ore
	}

	/**
	 * Accoda la verifica successiva.
	 *
	 * Il controllo anti-duplicato guarda le sole azioni in attesa e non usa
	 * as_has_scheduled_action, che considera in attesa anche quelle in corso.
	 * Poiché questo metodo viene chiamato dall'interno della verifica stessa,
	 * quella funzione troverebbe l'azione che sta girando e concluderebbe che
	 * il lavoro è già accodato: il ciclo si fermerebbe dopo il primo giro,
	 * senza errori e senza che nulla lo segnali.
	 */
	private static function accoda_verifica( $order_id, $eseguite ) {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return;
		}
		$in_attesa = as_get_scheduled_actions( array(
			'hook'     => self::AZIONE_RICEVUTE,
			'args'     => array( 'order_id' => (int) $order_id ),
			'group'    => self::GRUPPO,
			'status'   => ActionScheduler_Store::STATUS_PENDING,
			'per_page' => 1,
		), 'ids' );
		if ( ! empty( $in_attesa ) ) {
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
		// Il SdI in produzione richiede la partita IVA: il caso è segnalato
		// sull'ordine al momento della trasmissione.
		$fiscal_id = preg_replace( '/\s+/', '', $leggi( 'cedente_piva' ) );
		if ( '' === $fiscal_id ) {
			$fiscal_id = preg_replace( '/\s+/', '', $leggi( 'cedente_cf' ) );
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

		$base   = $leggi( 'openapi_base_url' );
		$natura = strtoupper( $leggi( 'natura_iva_zero' ) );

		return array(
			'base_url'              => '' !== $base ? $base : 'https://test.sdi.openapi.it',
			'token'                 => $leggi( 'openapi_token' ),
			'fiscal_id'             => $fiscal_id,
			'cedente_e_piva'        => (bool) preg_match( '/^\d{11}$/', $fiscal_id ),
			'denominazione'         => $leggi( 'cedente_denominazione' ),
			'regime'                => '' !== $leggi( 'cedente_regime' ) ? $leggi( 'cedente_regime' ) : 'RF01',
			// Natura da dichiarare sulle righe senza IVA (N1-N7 con sottocodice),
			// obbligatoria dal tracciato quando l'aliquota è zero.
			'natura_iva_zero'       => preg_match( '/^N[1-7](\.\d{1,2})?$/', $natura ) ? $natura : '',
			'riferimento_normativo' => $leggi( 'riferimento_normativo' ),
			'sede'                  => array(
				'indirizzo' => $leggi( 'cedente_indirizzo' ),
				'cap'       => $leggi( 'cedente_cap' ),
				'comune'    => $leggi( 'cedente_comune' ),
				'provincia' => $leggi( 'cedente_provincia' ),
				'nazione'   => 'IT',
			),
		);
	}
}
