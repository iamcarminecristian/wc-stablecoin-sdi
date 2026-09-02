<?php
/**
 * Composizione della fattura elettronica dai dati dell'ordine (RF-06, §4.5).
 *
 * Produce il tracciato FatturaPA come XML. La serializzazione passa da
 * XMLWriter anziché da concatenazione di stringhe: l'escaping dei valori è
 * garantito dalla libreria, e i dati che finiscono nel documento provengono
 * dall'ordine, quindi in ultima analisi dal cliente.
 *
 * L'ordine degli elementi non è opzionale: le specifiche definiscono sequenze,
 * e un elemento fuori posto fa scartare la fattura. La struttura di questo file
 * segue perciò l'ordine del tracciato, non una comodità di scrittura.
 *
 * Un documento che il Sistema di Interscambio scarterebbe con certezza non
 * viene trasmesso: la composizione si ferma con un errore non transitorio,
 * portato all'attenzione dell'esercente, perché lo scarto arriverebbe comunque
 * e senza il contesto per capirlo.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Fattura {

	/**
	 * ============================================================
	 * SCELTE FISCALI ASSUNTE (§4.5 della tesi)
	 * ============================================================
	 * Argomentate sullo schema del tracciato, prive di prassi consolidata:
	 * per questo vivono tutte insieme e isolate dal resto della composizione,
	 * così che una revisione futura resti una modifica di poche righe in un
	 * solo punto.
	 *
	 * TIPO_DOCUMENTO       TD01, cessione di beni o prestazione di servizi.
	 * MODALITA_PAGAMENTO   MP05 (bonifico). Nessuno dei codici da MP01 a MP23
	 *                      descrive un incasso in moneta elettronica su registro
	 *                      distribuito, e la tabella non prevede un residuale.
	 *                      Il blocco DatiPagamento è facoltativo e privo di
	 *                      effetti sull'imposta: MP05 descrive il tratto che
	 *                      porta gli euro all'esercente, cioè il riscatto, e
	 *                      per questo è accompagnato da ADG_PAY_MODE, che
	 *                      dichiara la natura effettiva dell'incasso.
	 * CONDIZIONI_PAGAMENTO TP02, pagamento completo in una soluzione.
	 * ADG_*                Riferimenti on-chain in AltriDatiGestionali, blocco
	 *                      destinato dalle specifiche alle informazioni
	 *                      concordate fra le parti (RF-09). I TipoDato scelti
	 *                      non collidono con i valori riservati del tracciato
	 *                      1.9.1 (NB1-NB3, ESENZSPORT).
	 * CAUSALE_INCASSO      L'hash della transazione viaggia in Causale, che è
	 *                      lungo 200 caratteri: RiferimentoTesto si ferma a 60 e
	 *                      obbligherebbe a troncare un valore di 66. In
	 *                      alternativa lo si spezza in due voci ADG (TXHASH1,
	 *                      TXHASH2): si fa entrambe le cose, per leggibilità
	 *                      umana e per i lettori automatici dei gestionali.
	 */
	const TIPO_DOCUMENTO       = 'TD01';
	const MODALITA_PAGAMENTO   = 'MP05';
	const CONDIZIONI_PAGAMENTO = 'TP02';
	const ADG_CHAIN            = 'CHAIN';
	const ADG_PAY_ADDR         = 'PAY-ADDR';
	const ADG_PAY_MODE         = 'PAY-MODE';
	const ADG_TXHASH_1         = 'TXHASH1';
	const ADG_TXHASH_2         = 'TXHASH2';
	const PAY_MODE_VALORE      = 'Incasso in EMT su DLT; MP05 si riferisce al riscatto SEPA';
	const CAUSALE_INCASSO      = 'Incasso in EMT EURe. Hash transazione: %s';
	/** Fine delle scelte fiscali assunte. */

	/**
	 * Formato di trasmissione. L'attributo `versione` sull'elemento radice deve
	 * riportare lo stesso valore di FormatoTrasmissione: se divergono il SdI
	 * scarta la fattura con il codice 00428.
	 */
	const FORMATO_TRASMISSIONE = 'FPR12';

	/** Codice convenzionale per destinatari senza canale telematico. */
	const DESTINATARIO_DEFAULT = '0000000';

	/** Codice convenzionale per cessionari non stabiliti in Italia. */
	const DESTINATARIO_ESTERO = 'XXXXXXX';

	const NS_FATTURA = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2';

	/** Lunghezze massime dei campi testuali, da schema XSD del tracciato. */
	const MAX_RIFERIMENTO_TESTO = 60;
	const MAX_CAUSALE           = 200;
	const MAX_DENOMINAZIONE     = 80;
	const MAX_INDIRIZZO         = 60;
	const MAX_COMUNE            = 60;
	const MAX_DESCRIZIONE       = 1000;

	/** Aliquote IVA vigenti, cui si riconduce un valore ricavato per rapporto. */
	const ALIQUOTE_NOTE = array( 4.0, 5.0, 10.0, 22.0 );

	/**
	 * Numero progressivo della fattura, univoco nell'anno.
	 *
	 * Il contatore è per anno perché la numerazione riparte da uno a ogni
	 * esercizio. L'assegnazione è atomica sul database: un unico UPDATE che
	 * incrementa e registra il nuovo valore nella sessione (LAST_INSERT_ID),
	 * così che due esecutori concorrenti della coda ottengano numeri distinti.
	 * La versione precedente leggeva e riscriveva l'opzione in due passi, e
	 * con due esecutori attivi ha prodotto numeri duplicati: è il difetto
	 * emerso nella campagna del 1° settembre 2026 (§6.5 della tesi).
	 */
	public static function prossimo_numero( $anno ) {
		global $wpdb;
		$chiave = 'wcsdi_numeratore_' . (int) $anno;

		// Crea la riga se manca; se esiste, add_option non la tocca.
		add_option( $chiave, 0, '', 'no' );

		$wpdb->query( $wpdb->prepare(
			"UPDATE {$wpdb->options} SET option_value = LAST_INSERT_ID( option_value + 1 ) WHERE option_name = %s",
			$chiave
		) );
		$n = (int) $wpdb->get_var( 'SELECT LAST_INSERT_ID()' );

		// La cache delle opzioni conserva il valore precedente: va invalidata,
		// altrimenti una lettura successiva nella stessa richiesta lo riporta.
		wp_cache_delete( $chiave, 'options' );
		wp_cache_delete( 'alloptions', 'options' );

		if ( $n <= 0 ) {
			// Sessione senza LAST_INSERT_ID (non dovrebbe accadere): si legge
			// il valore appena scritto, che resta comunque incrementato.
			$n = (int) $wpdb->get_var( $wpdb->prepare(
				"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
				$chiave
			) );
		}
		return $n;
	}

	/**
	 * Anno della serie cui il documento appartiene: quello della sua data,
	 * non quello dell'istante di trasmissione, che con i ritentativi può
	 * cadere nell'anno successivo e collocare il numero nella serie sbagliata.
	 */
	public static function anno_documento( WC_Order $order ) {
		return (int) substr( self::data_effettuazione( $order ), 0, 4 );
	}

	/**
	 * Compone la fattura per l'ordine indicato.
	 *
	 * @param WC_Order $order  Ordine già pagato.
	 * @param array    $config Dati del cedente dalla configurazione del gateway.
	 * @param int      $numero Numero progressivo assegnato.
	 * @return string Documento XML pronto per la trasmissione.
	 * @throws WCSDI_SdI_Exception Se il documento verrebbe scartato con certezza.
	 */
	public static function componi( WC_Order $order, array $config, $numero ) {
		$righe = self::righe( $order, $config );
		if ( empty( $righe ) ) {
			// Meglio fermarsi qui che trasmettere un documento che il
			// fornitore rifiuterebbe con un messaggio meno comprensibile.
			throw new WCSDI_SdI_Exception(
				sprintf( 'Ordine %d privo di righe fatturabili', $order->get_id() ),
				false
			);
		}

		$riepilogo = self::riepilogo( $righe );
		$totale    = (float) $order->get_total();

		$w = new XMLWriter();
		$w->openMemory();
		$w->setIndent( true );
		$w->setIndentString( '  ' );
		$w->startDocument( '1.0', 'UTF-8' );

		$w->startElementNS( 'p', 'FatturaElettronica', self::NS_FATTURA );
		$w->writeAttribute( 'versione', self::FORMATO_TRASMISSIONE );

		self::scrivi_header( $w, $order, $config, $numero );
		self::body( $w, $order, $numero, $righe, $riepilogo, $totale, $config );

		$w->endElement();
		$w->endDocument();

		return $w->outputMemory();
	}

	/**
	 * Intestazione del documento: trasmittente, cedente e cessionario.
	 * È pubblica perché identica per la fattura e per la nota di credito, e
	 * duplicarla significherebbe lasciarle divergere alla prima modifica.
	 */
	public static function scrivi_header( XMLWriter $w, WC_Order $order, array $config, $numero ) {
		$estero = self::cessionario_estero( $order );

		$w->startElement( 'FatturaElettronicaHeader' );

		$w->startElement( 'DatiTrasmissione' );
		$w->startElement( 'IdTrasmittente' );
		$w->writeElement( 'IdPaese', 'IT' );
		$w->writeElement( 'IdCodice', $config['fiscal_id'] );
		$w->endElement();
		$w->writeElement( 'ProgressivoInvio', str_pad( (string) $numero, 5, '0', STR_PAD_LEFT ) );
		$w->writeElement( 'FormatoTrasmissione', self::FORMATO_TRASMISSIONE );
		$w->writeElement( 'CodiceDestinatario', self::codice_destinatario( $order, $estero ) );
		$pec = self::pec_destinatario( $order );
		if ( null !== $pec && ! $estero ) {
			$w->writeElement( 'PECDestinatario', $pec );
		}
		$w->endElement();

		$w->startElement( 'CedentePrestatore' );
		$w->startElement( 'DatiAnagrafici' );
		$w->startElement( 'IdFiscaleIVA' );
		$w->writeElement( 'IdPaese', 'IT' );
		$w->writeElement( 'IdCodice', $config['fiscal_id'] );
		$w->endElement();
		$w->startElement( 'Anagrafica' );
		$w->writeElement( 'Denominazione', self::campo( $config['denominazione'], self::MAX_DENOMINAZIONE, 'denominazione del cedente' ) );
		$w->endElement();
		$w->writeElement( 'RegimeFiscale', $config['regime'] );
		$w->endElement();
		self::sede( $w, $config['sede'], false );
		$w->endElement();

		$w->startElement( 'CessionarioCommittente' );
		self::anagrafica_cessionario( $w, $order, $estero );
		self::sede( $w, self::sede_cessionario( $order ), $estero );
		$w->endElement();

		$w->endElement();
	}

	private static function body( XMLWriter $w, WC_Order $order, $numero, array $righe, array $riepilogo, $totale, array $config ) {
		$w->startElement( 'FatturaElettronicaBody' );

		$w->startElement( 'DatiGenerali' );
		$w->startElement( 'DatiGeneraliDocumento' );
		$w->writeElement( 'TipoDocumento', self::TIPO_DOCUMENTO );
		$w->writeElement( 'Divisa', 'EUR' );
		// Momento di effettuazione: la data in cui il pagamento on-chain si è
		// perfezionato secondo il criterio di conferma configurato, non quella
		// della trasmissione, che può cadere più tardi per effetto dei
		// ritentativi (§4.5; art. 6, c. 3 e 4, DPR 633/72 per il pagamento
		// anticipato; Data = data di effettuazione, Circ. AdE 14/E/2019).
		$w->writeElement( 'Data', self::data_effettuazione( $order ) );
		$w->writeElement( 'Numero', (string) $numero );
		$w->writeElement( 'ImportoTotaleDocumento', self::dec( $totale ) );
		// Causale chiude la sequenza di DatiGeneraliDocumento: un elemento
		// fuori posto fa scartare il documento.
		foreach ( self::causali( $order ) as $causale ) {
			$w->writeElement( 'Causale', $causale );
		}
		$w->endElement();
		$w->endElement();

		$w->startElement( 'DatiBeniServizi' );
		$adg = self::riferimenti_onchain( $order );
		foreach ( $righe as $i => $riga ) {
			$w->startElement( 'DettaglioLinee' );
			$w->writeElement( 'NumeroLinea', (string) ( $i + 1 ) );
			$w->writeElement( 'Descrizione', $riga['descrizione'] );
			if ( null !== $riga['quantita'] ) {
				$w->writeElement( 'Quantita', self::dec( $riga['quantita'] ) );
			}
			// Il prezzo unitario ammette fino a otto decimali: con due, per
			// quantità che non dividono esattamente il totale, PrezzoUnitario
			// per Quantita divergerebbe da PrezzoTotale oltre la tolleranza
			// del controllo 00423.
			$w->writeElement( 'PrezzoUnitario', self::dec8( $riga['prezzo_unitario'] ) );
			$w->writeElement( 'PrezzoTotale', self::dec( $riga['imponibile'] ) );
			$w->writeElement( 'AliquotaIVA', self::dec( $riga['aliquota'] ) );
			if ( null !== $riga['natura'] ) {
				$w->writeElement( 'Natura', $riga['natura'] );
			}
			// I riferimenti on-chain descrivono l'incasso nel suo insieme, non
			// la singola riga: si riportano una volta sola, sulla prima.
			if ( 0 === $i ) {
				foreach ( $adg as $dato ) {
					$w->startElement( 'AltriDatiGestionali' );
					$w->writeElement( 'TipoDato', $dato['tipo'] );
					$w->writeElement( 'RiferimentoTesto', $dato['valore'] );
					$w->endElement();
				}
			}
			$w->endElement();
		}

		foreach ( $riepilogo as $voce ) {
			$w->startElement( 'DatiRiepilogo' );
			$w->writeElement( 'AliquotaIVA', self::dec( $voce['aliquota'] ) );
			if ( null !== $voce['natura'] ) {
				$w->writeElement( 'Natura', $voce['natura'] );
			}
			$w->writeElement( 'ImponibileImporto', self::dec( $voce['imponibile'] ) );
			$w->writeElement( 'Imposta', self::dec( $voce['imposta'] ) );
			$w->writeElement( 'EsigibilitaIVA', 'I' );
			if ( null !== $voce['natura'] && ! empty( $config['riferimento_normativo'] ) ) {
				$w->writeElement( 'RiferimentoNormativo', self::campo( $config['riferimento_normativo'], 100, 'riferimento normativo' ) );
			}
			$w->endElement();
		}
		$w->endElement();

		$w->startElement( 'DatiPagamento' );
		$w->writeElement( 'CondizioniPagamento', self::CONDIZIONI_PAGAMENTO );
		$w->startElement( 'DettaglioPagamento' );
		$w->writeElement( 'ModalitaPagamento', self::MODALITA_PAGAMENTO );
		$w->writeElement( 'ImportoPagamento', self::dec( $totale ) );
		$w->endElement();
		$w->endElement();

		$w->endElement();
	}

	/**
	 * Righe del documento: articoli, commissioni e spese di spedizione, che il
	 * tracciato tratta ciascuna come riga con la propria aliquota.
	 *
	 * @throws WCSDI_SdI_Exception Riga con più aliquote, o a IVA zero senza Natura.
	 */
	private static function righe( WC_Order $order, array $config ) {
		$righe = array();

		// get_items() senza argomenti restituisce le sole righe prodotto: le
		// commissioni e la spedizione sono righe fatturabili a tutti gli
		// effetti e vanno chieste esplicitamente, altrimenti il documento
		// nasce senza corpo.
		foreach ( $order->get_items( array( 'line_item', 'fee', 'shipping' ) ) as $item ) {
			$imponibile = (float) $item->get_total();
			$imposta    = (float) $item->get_total_tax();
			$quantita   = method_exists( $item, 'get_quantity' ) ? (float) $item->get_quantity() : 0.0;
			if ( 'shipping' === $item->get_type() ) {
				$quantita = 0.0;
				if ( $imponibile <= 0 ) {
					continue;
				}
			}

			$aliquota = self::aliquota_item( $item, $imponibile, $imposta );
			$natura   = null;
			if ( $aliquota <= 0.0 && $imponibile > 0 ) {
				$natura = ! empty( $config['natura_iva_zero'] ) ? $config['natura_iva_zero'] : null;
				if ( null === $natura ) {
					throw new WCSDI_SdI_Exception(
						sprintf(
							'La riga "%s" ha IVA zero e il tracciato richiede l\'elemento Natura (N1-N7): impostare "Natura per operazioni senza IVA" nella configurazione del gateway.',
							$item->get_name()
						),
						false
					);
				}
			}

			$righe[] = array(
				'descrizione'     => self::campo( 'shipping' === $item->get_type() ? __( 'Spese di spedizione', 'wc-stablecoin-sdi' ) : $item->get_name(), self::MAX_DESCRIZIONE, 'descrizione di riga' ),
				'quantita'        => $quantita > 0 ? $quantita : null,
				'prezzo_unitario' => $quantita > 0 ? $imponibile / $quantita : $imponibile,
				'imponibile'      => $imponibile,
				'imposta'         => $imposta,
				'aliquota'        => $aliquota,
				'natura'          => $natura,
			);
		}

		// Il documento deve valere quanto l'incasso: un ordine le cui righe
		// non sommano al totale (per esempio una riga senza imposta su un
		// totale lordo) produrrebbe una fattura che non corrisponde a quanto
		// il cliente ha pagato. Meglio fermarsi che trasmetterla.
		$somma = 0.0;
		foreach ( $righe as $riga ) {
			$somma += $riga['imponibile'] + $riga['imposta'];
		}
		if ( abs( $somma - (float) $order->get_total() ) > 0.02 ) {
			throw new WCSDI_SdI_Exception(
				sprintf( 'Le righe dell\'ordine sommano a %s, il totale incassato è %s: il documento non corrisponde al pagamento.', self::dec( $somma ), self::dec( (float) $order->get_total() ) ),
				false
			);
		}

		return $righe;
	}

	/**
	 * Aliquota IVA di una riga dell'ordine.
	 *
	 * L'aliquota è un dato normativo, non una grandezza da stimare: si legge
	 * dalla tariffa che WooCommerce ha applicato alla riga. Il rapporto fra
	 * imposta e imponibile, entrambi già arrotondati al centesimo, produce sui
	 * prezzi lordi più comuni valori inesistenti (9,99 euro lordi al 22 per
	 * cento danno 21,98). Solo se la tariffa non è recuperabile si ricava il
	 * rapporto e lo si riconduce all'aliquota vigente più vicina.
	 *
	 * @throws WCSDI_SdI_Exception Se la riga porta più aliquote.
	 */
	public static function aliquota_item( $item, $imponibile, $imposta ) {
		$tasse  = method_exists( $item, 'get_taxes' ) ? $item->get_taxes() : array();
		$totali = isset( $tasse['total'] ) && is_array( $tasse['total'] ) ? $tasse['total'] : array();
		$attive = array();
		foreach ( $totali as $rate_id => $importo ) {
			if ( 0.0 !== (float) $importo ) {
				$attive[ (int) $rate_id ] = (float) $importo;
			}
		}

		if ( count( $attive ) > 1 ) {
			throw new WCSDI_SdI_Exception(
				sprintf( 'La riga "%s" porta più aliquote IVA: il tracciato richiede una riga per aliquota.', $item->get_name() ),
				false
			);
		}

		if ( 1 === count( $attive ) && class_exists( 'WC_Tax' ) ) {
			$rate_id = (int) array_key_first( $attive );
			$tariffa = WC_Tax::_get_tax_rate( $rate_id );
			if ( is_array( $tariffa ) && isset( $tariffa['tax_rate'] ) ) {
				return round( (float) $tariffa['tax_rate'], 2 );
			}
		}

		if ( $imponibile <= 0 || $imposta <= 0 ) {
			return 0.0;
		}
		$derivata = $imposta / $imponibile * 100;
		foreach ( self::ALIQUOTE_NOTE as $nota ) {
			if ( abs( $derivata - $nota ) < 0.5 ) {
				return $nota;
			}
		}
		return round( $derivata, 2 );
	}

	/** Riepilogo per aliquota: il tracciato ne vuole uno per ciascuna. */
	private static function riepilogo( array $righe ) {
		$per_aliquota = array();
		foreach ( $righe as $riga ) {
			$k = self::dec( $riga['aliquota'] ) . '|' . (string) $riga['natura'];
			if ( ! isset( $per_aliquota[ $k ] ) ) {
				$per_aliquota[ $k ] = array( 'aliquota' => $riga['aliquota'], 'natura' => $riga['natura'], 'imponibile' => 0.0, 'imposta' => 0.0 );
			}
			$per_aliquota[ $k ]['imponibile'] += $riga['imponibile'];
			$per_aliquota[ $k ]['imposta']    += $riga['imposta'];
		}
		return array_values( $per_aliquota );
	}

	/**
	 * Riferimenti dell'incasso on-chain (RF-09).
	 * Rendono la fattura autoportante ai fini di riconciliazione e controllo:
	 * dal solo documento si risale alla transazione che lo ha originato.
	 */
	private static function riferimenti_onchain( WC_Order $order ) {
		$hash   = (string) $order->get_meta( '_wcsdi_tx_hash' );
		$valori = array(
			self::ADG_CHAIN    => (string) $order->get_meta( '_wcsdi_chain' ),
			self::ADG_PAY_ADDR => (string) $order->get_meta( '_wcsdi_receive_address' ),
			// Qualifica MP05: senza, il documento dichiarerebbe un bonifico
			// che il cliente non ha disposto.
			self::ADG_PAY_MODE => self::PAY_MODE_VALORE,
		);
		if ( '' !== $hash && strlen( $hash ) > self::MAX_RIFERIMENTO_TESTO ) {
			// L'hash non entra in un solo RiferimentoTesto: si spezza in due
			// voci da trentatré caratteri ciascuna, per intero.
			$meta = (int) ceil( strlen( $hash ) / 2 );
			$valori[ self::ADG_TXHASH_1 ] = substr( $hash, 0, $meta );
			$valori[ self::ADG_TXHASH_2 ] = substr( $hash, $meta );
		}

		$out = array();
		foreach ( $valori as $tipo => $valore ) {
			if ( '' === $valore ) {
				continue;
			}
			$out[] = array( 'tipo' => $tipo, 'valore' => substr( $valore, 0, self::MAX_RIFERIMENTO_TESTO ) );
		}
		return $out;
	}

	/**
	 * Causali del documento. Vi viaggia l'hash della transazione per intero,
	 * leggibile da un operatore: sono 66 caratteri contro i 200 ammessi.
	 */
	private static function causali( WC_Order $order ) {
		$hash = (string) $order->get_meta( '_wcsdi_tx_hash' );
		if ( '' === $hash ) {
			return array();
		}
		return array( substr( sprintf( self::CAUSALE_INCASSO, $hash ), 0, self::MAX_CAUSALE ) );
	}

	/**
	 * Un cessionario è estero se il paese di fatturazione non è l'Italia. Per
	 * lui il tracciato prevede il codice destinatario convenzionale XXXXXXX,
	 * l'identificativo fiscale del proprio paese e nessun codice fiscale
	 * italiano.
	 */
	public static function cessionario_estero( WC_Order $order ) {
		$paese = strtoupper( trim( (string) $order->get_billing_country() ) );
		return '' !== $paese && 'IT' !== $paese;
	}

	/**
	 * @throws WCSDI_SdI_Exception Se manca l'identificativo fiscale (scarto 00417).
	 */
	private static function anagrafica_cessionario( XMLWriter $w, WC_Order $order, $estero ) {
		$piva = strtoupper( trim( (string) $order->get_meta( '_wcsdi_piva' ) ) );
		$cf   = strtoupper( trim( (string) $order->get_meta( '_wcsdi_codice_fiscale' ) ) );

		if ( '' === $piva && ( '' === $cf || $estero ) ) {
			throw new WCSDI_SdI_Exception(
				$estero
					? 'Cessionario non stabilito in Italia senza identificativo fiscale del proprio paese: il tracciato lo richiede (controllo 00417).'
					: 'Cessionario senza codice fiscale né partita IVA: il tracciato richiede almeno uno dei due (controllo 00417). I dati si raccolgono al checkout.',
				false
			);
		}

		$denominazione = trim( (string) $order->get_billing_company() );
		if ( '' === $denominazione ) {
			$denominazione = trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() );
		}
		if ( '' === $denominazione ) {
			$denominazione = __( 'Cliente', 'wc-stablecoin-sdi' );
		}

		$w->startElement( 'DatiAnagrafici' );
		if ( '' !== $piva ) {
			$w->startElement( 'IdFiscaleIVA' );
			$w->writeElement( 'IdPaese', $estero ? strtoupper( (string) $order->get_billing_country() ) : 'IT' );
			$w->writeElement( 'IdCodice', substr( $piva, 0, 28 ) );
			$w->endElement();
		}
		if ( '' !== $cf && ! $estero ) {
			$w->writeElement( 'CodiceFiscale', substr( $cf, 0, 16 ) );
		}
		$w->startElement( 'Anagrafica' );
		$w->writeElement( 'Denominazione', self::campo( $denominazione, self::MAX_DENOMINAZIONE, 'denominazione del cessionario' ) );
		$w->endElement();
		$w->endElement();
	}

	private static function sede_cessionario( WC_Order $order ) {
		return array(
			'indirizzo' => $order->get_billing_address_1(),
			'cap'       => $order->get_billing_postcode(),
			'comune'    => $order->get_billing_city(),
			'provincia' => $order->get_billing_state(),
			'nazione'   => $order->get_billing_country() ? strtoupper( $order->get_billing_country() ) : 'IT',
		);
	}

	/**
	 * @throws WCSDI_SdI_Exception Se un campo obbligatorio è vuoto o fuori formato.
	 */
	private static function sede( XMLWriter $w, array $sede, $estero ) {
		$cap = preg_replace( '/\s+/', '', (string) $sede['cap'] );
		if ( $estero ) {
			// Per l'estero il tracciato accetta solo cinque cifre: si usa il
			// valore convenzionale, e il CAP reale resta nell'indirizzo.
			$cap = '00000';
		} elseif ( ! preg_match( '/^\d{5}$/', $cap ) ) {
			throw new WCSDI_SdI_Exception( sprintf( 'CAP "%s" non valido: il tracciato richiede cinque cifre.', $sede['cap'] ), false );
		}

		$w->startElement( 'Sede' );
		$w->writeElement( 'Indirizzo', self::campo( $sede['indirizzo'], self::MAX_INDIRIZZO, 'indirizzo' ) );
		$w->writeElement( 'CAP', $cap );
		$w->writeElement( 'Comune', self::campo( $sede['comune'], self::MAX_COMUNE, 'comune' ) );
		// La provincia è facoltativa e vuole la sigla di due lettere: un
		// valore più lungo, come il nome esteso, farebbe scartare la fattura.
		// Per l'estero si omette: la sigla di uno stato straniero non è una
		// provincia italiana.
		if ( ! $estero && ! empty( $sede['provincia'] ) && 2 === strlen( $sede['provincia'] ) ) {
			$w->writeElement( 'Provincia', strtoupper( $sede['provincia'] ) );
		}
		$w->writeElement( 'Nazione', $sede['nazione'] );
		$w->endElement();
	}

	private static function codice_destinatario( WC_Order $order, $estero ) {
		if ( $estero ) {
			return self::DESTINATARIO_ESTERO;
		}
		$codice = strtoupper( trim( (string) $order->get_meta( '_wcsdi_codice_destinatario' ) ) );
		return preg_match( '/^[A-Z0-9]{7}$/', $codice ) ? $codice : self::DESTINATARIO_DEFAULT;
	}

	private static function pec_destinatario( WC_Order $order ) {
		$pec = trim( (string) $order->get_meta( '_wcsdi_pec' ) );
		return '' !== $pec && is_email( $pec ) ? $pec : null;
	}

	/**
	 * Data di effettuazione, nel fuso del negozio: l'istante in cui il
	 * pagamento è stato riconciliato secondo il criterio di conferma.
	 */
	public static function data_effettuazione( WC_Order $order ) {
		$pagato = $order->get_date_paid();
		return $pagato ? $pagato->date_i18n( 'Y-m-d' ) : wp_date( 'Y-m-d' );
	}

	/**
	 * Normalizza un campo testuale entro la lunghezza dello schema.
	 *
	 * @throws WCSDI_SdI_Exception Se il campo è obbligatorio e vuoto.
	 */
	public static function campo( $valore, $max, $nome ) {
		$valore = trim( preg_replace( '/\s+/u', ' ', (string) $valore ) );
		if ( '' === $valore ) {
			throw new WCSDI_SdI_Exception( sprintf( 'Campo obbligatorio vuoto: %s.', $nome ), false );
		}
		return function_exists( 'mb_substr' ) ? mb_substr( $valore, 0, $max ) : substr( $valore, 0, $max );
	}

	public static function dec( $n ) {
		return number_format( (float) $n, 2, '.', '' );
	}

	/** Fino a otto decimali, senza zeri superflui oltre il secondo. */
	public static function dec8( $n ) {
		$s = number_format( (float) $n, 8, '.', '' );
		$s = rtrim( $s, '0' );
		if ( strlen( $s ) - strpos( $s, '.' ) - 1 < 2 ) {
			$s = number_format( (float) $n, 2, '.', '' );
		}
		return $s;
	}
}
