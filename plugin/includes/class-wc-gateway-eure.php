<?php
/**
 * Gateway di pagamento EURe (RF-01, RF-02, RF-08; tesi §4.1-§4.2, §5.2, §5.5).
 *
 * Al checkout il gateway non contatta alcun servizio esterno: calcola il
 * riferimento dell'ordine, registra le coordinate di pagamento e restituisce
 * il controllo alla piattaforma (RNF-06). La transizione di stato avviene
 * alla notifica del servizio di rilevamento.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Gateway_EURe extends WC_Payment_Gateway {

	/**
	 * Reti su cui l'emittente distribuisce EURe, con identificativo numerico.
	 * L'elenco segue GET /tokens dell'emittente (settembre 2026); le reti di
	 * prova sono quelle del suo ambiente sandbox. La catena locale di
	 * sviluppo serve alle verifiche offline.
	 */
	const CHAIN_IDS = array(
		'ethereum'       => 1,
		'gnosis'         => 100,
		'polygon'        => 137,
		'arbitrum'       => 42161,
		'base'           => 8453,
		'linea'          => 59144,
		'sepolia'        => 11155111,
		'basesepolia'    => 84532,
		'chiado'         => 10200,
		'arbitrumsepolia' => 421614,
		'lineasepolia'   => 59141,
		'anvil'          => 31337,
	);

	public function __construct() {
		$this->id                 = 'wcsdi_eure';
		$this->method_title       = __( 'Stablecoin EUR (EURe) + SdI', 'wc-stablecoin-sdi' );
		$this->method_description = __( 'Accetta pagamenti in EURe con conversione automatica in EUR (riscatto alla pari presso l\'emittente, accredito SEPA) e fatturazione elettronica automatica tramite SdI.', 'wc-stablecoin-sdi' );
		$this->has_fields         = true;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_filter( 'woocommerce_settings_api_sanitized_fields_' . $this->id, array( $this, 'sincronizza_segreto' ) );
	}

	/** Identificativo numerico della rete configurata. */
	public static function chain_id( $chain ) {
		return isset( self::CHAIN_IDS[ $chain ] ) ? (int) self::CHAIN_IDS[ $chain ] : 0;
	}

	/** Etichette leggibili delle reti. */
	public static function reti() {
		return array(
			'gnosis'          => __( 'Gnosis Chain', 'wc-stablecoin-sdi' ),
			'base'            => __( 'Base', 'wc-stablecoin-sdi' ),
			'ethereum'        => __( 'Ethereum', 'wc-stablecoin-sdi' ),
			'polygon'         => __( 'Polygon', 'wc-stablecoin-sdi' ),
			'arbitrum'        => __( 'Arbitrum One', 'wc-stablecoin-sdi' ),
			'linea'           => __( 'Linea', 'wc-stablecoin-sdi' ),
			'basesepolia'     => __( 'Base Sepolia (rete di prova)', 'wc-stablecoin-sdi' ),
			'chiado'          => __( 'Gnosis Chiado (rete di prova)', 'wc-stablecoin-sdi' ),
			'sepolia'         => __( 'Ethereum Sepolia (rete di prova)', 'wc-stablecoin-sdi' ),
			'arbitrumsepolia' => __( 'Arbitrum Sepolia (rete di prova)', 'wc-stablecoin-sdi' ),
			'lineasepolia'    => __( 'Linea Sepolia (rete di prova)', 'wc-stablecoin-sdi' ),
			'anvil'           => __( 'Catena locale di sviluppo (anvil)', 'wc-stablecoin-sdi' ),
		);
	}

	/**
	 * Superficie di configurazione dell'esercente (RF-08).
	 * Ogni campo è tracciato sul requisito o sulla sezione di tesi pertinente.
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'     => array(
				'title'   => __( 'Abilita', 'wc-stablecoin-sdi' ),
				'type'    => 'checkbox',
				'label'   => __( 'Abilita il pagamento in EURe', 'wc-stablecoin-sdi' ),
				'default' => 'no',
			),
			'title'       => array(
				'title'   => __( 'Titolo al checkout', 'wc-stablecoin-sdi' ),
				'type'    => 'text',
				'default' => __( 'Paga in EURe (euro tokenizzato)', 'wc-stablecoin-sdi' ),
			),
			'description' => array(
				'title'       => __( 'Descrizione al checkout', 'wc-stablecoin-sdi' ),
				'type'        => 'textarea',
				'default'     => __( 'Il pagamento avviene invocando il contratto di inoltro con il riferimento dell\'ordine, dal tuo portafoglio. Non inviare EURe con un trasferimento semplice all\'indirizzo del contratto: i token non sarebbero attribuiti né recuperabili. L\'ordine si conferma automaticamente.', 'wc-stablecoin-sdi' ),
			),
			'informativa' => array(
				'title'       => __( 'Informativa precontrattuale', 'wc-stablecoin-sdi' ),
				'type'        => 'textarea',
				'description' => __( 'Mostrata al checkout prima della conferma dell\'ordine (art. 49 Codice del consumo; art. 13 GDPR).', 'wc-stablecoin-sdi' ),
				'default'     => __( 'Per pagare servono un portafoglio compatibile, euro tokenizzati EURe sulla rete indicata e una piccola quantità della valuta nativa della rete per il costo di rete, che paghi alla rete e non a noi. Una volta confermato, il trasferimento non è revocabile dal pagatore: non esiste uno storno unilaterale come per le carte. Conservi per intero i diritti di legge del contratto a distanza, incluso il recesso entro quattordici giorni: il rimborso avviene in EURe all\'indirizzo da cui hai pagato, salvo diverso accordo. Il riferimento di pagamento vale per la finestra indicata. L\'indirizzo da cui paghi e l\'identificativo della transazione restano registrati sull\'ordine e riportati nella fattura elettronica per obblighi di riconciliazione e conservazione (dieci anni).', 'wc-stablecoin-sdi' ),
			),

			// --- Rete e rilevamento (RF-01, RF-03, §4.3) ---
			'network_section' => array( 'title' => __( 'Rete e rilevamento', 'wc-stablecoin-sdi' ), 'type' => 'title' ),
			'chain'           => array(
				'title'       => __( 'Rete', 'wc-stablecoin-sdi' ),
				'type'        => 'select',
				'options'     => self::reti(),
				'default'     => 'gnosis',
				'description' => __( 'Rete su cui accettare EURe. Deve coincidere con la rete su cui è pubblicato il contratto di inoltro e con quella collegata all\'IBAN presso l\'emittente. Il servizio di rilevamento legge questa configurazione all\'avvio e rifiuta i pagamenti osservati su una rete diversa.', 'wc-stablecoin-sdi' ),
			),
			'token_address'   => array(
				'title'       => __( 'Contratto del token EURe', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Indirizzo del contratto EURe sulla rete scelta, da GET /tokens dell\'emittente. Serve al cliente per l\'autorizzazione e al servizio per le verifiche.', 'wc-stablecoin-sdi' ),
			),
			'receive_address' => array(
				'title'       => __( 'Indirizzo di incasso', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Indirizzo in controllo esclusivo dell\'esercente, collegato all\'IBAN in fase di onboarding presso l\'emittente (RNF-02).', 'wc-stablecoin-sdi' ),
			),
			'forwarder_address' => array(
				'title'       => __( 'Contratto di inoltro', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Indirizzo del contratto che riceve i pagamenti e ne registra il riferimento all\'ordine (§4.3). Va pubblicato una tantum sulla rete scelta; senza, i pagamenti non sono attribuibili ai singoli ordini.', 'wc-stablecoin-sdi' ),
			),
			'finality_mode'   => array(
				'title'       => __( 'Criterio di conferma', 'wc-stablecoin-sdi' ),
				'type'        => 'select',
				'options'     => array(
					'finalized'     => __( 'finalized: finalità del consenso sottostante (circa 20 minuti su Base, meno di 4 su Gnosis)', 'wc-stablecoin-sdi' ),
					'safe'          => __( 'safe: lotto pubblicato sulla rete sottostante (2-7 minuti su Base)', 'wc-stablecoin-sdi' ),
					'confirmations' => __( 'conteggio delle conferme: nessuna garanzia ancorata alla rete sottostante, fiducia nel sequencer', 'wc-stablecoin-sdi' ),
				),
				'default'     => 'finalized',
				'description' => __( 'Su una rete di secondo livello il conteggio delle conferme non misura la finalità: i blocchi restano revocabili finché il lotto non è pubblicato e finalizzato (Capitolo 6). Il servizio di rilevamento legge il valore all\'avvio; una variabile d\'ambiente nel servizio ha la precedenza.', 'wc-stablecoin-sdi' ),
			),
			'confirmations'   => array(
				'title'       => __( 'Conferme richieste', 'wc-stablecoin-sdi' ),
				'type'        => 'number',
				'default'     => '12',
				'description' => __( 'Usato solo con il criterio a conteggio delle conferme.', 'wc-stablecoin-sdi' ),
			),
			'payment_window'  => array(
				'title'       => __( 'Finestra di pagamento (minuti)', 'wc-stablecoin-sdi' ),
				'type'        => 'number',
				'default'     => '60',
				'description' => __( 'Oltre la finestra, più un margine proporzionato al criterio di conferma, l\'ordine non pagato passa in failed (RF-04). Un pagamento completo giunto dopo riapre l\'ordine.', 'wc-stablecoin-sdi' ),
			),
			'watcher_secret'  => array(
				'title'       => __( 'Segreto del servizio di rilevamento', 'wc-stablecoin-sdi' ),
				'type'        => 'password',
				'description' => __( 'Deve coincidere con WCSDI_SHARED_SECRET nella configurazione del servizio. Lasciare vuoto per non modificarlo. Un valore casuale di almeno 32 caratteri; il canale fra servizio e negozio deve essere cifrato.', 'wc-stablecoin-sdi' ),
			),

			// --- Conversione automatica (RF-05, §4.4) ---
			// Le credenziali dell'emittente non stanno qui di proposito. Il
			// riscatto richiede la firma dell'indirizzo di incasso, e quella
			// capacità risiede nel servizio di rilevamento, che è separato
			// dall'ambiente di esecuzione di WordPress e privo di superficie
			// esposta (§4.4). Il plugin non deve poter firmare nulla.
			'redemption_section' => array(
				'title'       => __( 'Conversione automatica in EUR (Monerium)', 'wc-stablecoin-sdi' ),
				'type'        => 'title',
				'description' => __( 'Si configura nel servizio di rilevamento, non qui: disporre il riscatto richiede una firma dell\'indirizzo di incasso, e il plugin non deve custodire chiavi (RNF-02, §4.4).', 'wc-stablecoin-sdi' ),
			),

			// --- Fatturazione elettronica (RF-06, RF-07, §4.5) ---
			'sdi_section'   => array( 'title' => __( 'Fatturazione elettronica (SdI via openapi.it)', 'wc-stablecoin-sdi' ), 'type' => 'title' ),
			'openapi_base_url' => array(
				'title'       => __( 'Endpoint del fornitore', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'default'     => 'https://test.sdi.openapi.it',
				'description' => __( 'Sandbox: <code>https://test.sdi.openapi.it</code>. Produzione: <code>https://sdi.openapi.it</code>.', 'wc-stablecoin-sdi' ),
			),
			'openapi_token' => array(
				'title'       => __( 'Token del fornitore', 'wc-stablecoin-sdi' ),
				'type'        => 'password',
				'description' => __( 'Token della sezione Autenticazione della dashboard, non la API Key mostrata più in alto: sono due credenziali distinte.', 'wc-stablecoin-sdi' ),
			),
			'cedente_piva'  => array(
				'title'       => __( 'Partita IVA cedente', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Undici cifre. In produzione il SdI verifica che sia presente in Anagrafe Tributaria (controllo 00301).', 'wc-stablecoin-sdi' ),
			),
			'cedente_cf'    => array(
				'title'       => __( 'Codice fiscale cedente', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Usato come identificativo solo se la partita IVA non è valorizzata: accettato dal fornitore in ambiente di prova, non dal SdI in produzione.', 'wc-stablecoin-sdi' ),
			),
			'cedente_denominazione' => array( 'title' => __( 'Denominazione cedente', 'wc-stablecoin-sdi' ), 'type' => 'text' ),
			'cedente_indirizzo'     => array( 'title' => __( 'Indirizzo (sede)', 'wc-stablecoin-sdi' ), 'type' => 'text' ),
			'cedente_cap'           => array( 'title' => __( 'CAP (sede)', 'wc-stablecoin-sdi' ), 'type' => 'text' ),
			'cedente_comune'        => array( 'title' => __( 'Comune (sede)', 'wc-stablecoin-sdi' ), 'type' => 'text' ),
			'cedente_provincia'     => array(
				'title'       => __( 'Provincia (sede)', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Sigla di due lettere, ad esempio RM.', 'wc-stablecoin-sdi' ),
			),
			'cedente_regime'        => array(
				'title'       => __( 'Regime fiscale', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'default'     => 'RF01',
				'description' => __( 'Codice RF01-RF19 del tracciato. Il prototipo tratta il caso ordinario RF01 con IVA positiva; per i regimi senza IVA impostare la Natura qui sotto.', 'wc-stablecoin-sdi' ),
			),
			'natura_iva_zero'       => array(
				'title'       => __( 'Natura per operazioni senza IVA', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Codice N1-N7 con sottocodice (per esempio N2.2 per il regime forfetario). Obbligatorio dal tracciato quando una riga ha aliquota zero; senza, la fattura non viene trasmessa.', 'wc-stablecoin-sdi' ),
			),
			'riferimento_normativo' => array(
				'title'       => __( 'Riferimento normativo per le operazioni senza IVA', 'wc-stablecoin-sdi' ),
				'type'        => 'text',
				'description' => __( 'Testo riportato nel riepilogo, per esempio «Operazione non soggetta a IVA ai sensi dell\'art. 1, c. 54-89, L. 190/2014».', 'wc-stablecoin-sdi' ),
			),
		);
	}

	/**
	 * Il segreto vive nell'opzione letta dagli endpoint REST, separata dalle
	 * impostazioni del gateway (che WooCommerce espone anche altrove). Il
	 * campo del pannello serve solo a impostarlo: non lo si conserva fra le
	 * impostazioni.
	 */
	public function sincronizza_segreto( $campi ) {
		if ( ! empty( $campi['watcher_secret'] ) ) {
			update_option( 'wcsdi_watcher_secret', (string) $campi['watcher_secret'], false );
		}
		$campi['watcher_secret'] = '';
		return $campi;
	}

	/**
	 * Il metodo compare solo se ha senso: valuta del negozio in euro (la
	 * parità 1:1 vale fra EURe ed euro), contratto di inoltro e indirizzo di
	 * incasso configurati, segreto del servizio impostato. Senza, il cliente
	 * riceverebbe istruzioni inutilizzabili e l'ordine scadrebbe in failed.
	 */
	public function is_available() {
		if ( ! parent::is_available() ) {
			return false;
		}
		if ( 'EUR' !== get_woocommerce_currency() ) {
			return false;
		}
		$indirizzo = '/^0x[0-9a-fA-F]{40}$/';
		if ( ! preg_match( $indirizzo, (string) $this->get_option( 'forwarder_address' ) )
			|| ! preg_match( $indirizzo, (string) $this->get_option( 'receive_address' ) ) ) {
			return false;
		}
		return '' !== (string) get_option( 'wcsdi_watcher_secret', '' );
	}

	/**
	 * Descrizione e informativa precontrattuale al checkout classico. Il
	 * checkout a blocchi riceve gli stessi testi dai dati del metodo.
	 */
	public function payment_fields() {
		if ( '' !== (string) $this->description ) {
			echo '<p>' . wp_kses_post( wpautop( wptexturize( $this->description ) ) ) . '</p>';
		}
		$informativa = (string) $this->get_option( 'informativa' );
		if ( '' !== $informativa ) {
			echo '<p class="wcsdi-informativa"><small>' . wp_kses_post( $informativa ) . '</small></p>';
		}
	}

	/**
	 * Riferimento dell'ordine da comunicare alla catena (RF-02).
	 *
	 * È derivato dall'identificativo dell'ordine tramite HMAC con una chiave
	 * a sua volta derivata dal segreto condiviso, per tre ragioni. Non è
	 * invertibile da un osservatore esterno, quindi la catena non espone
	 * l'identificativo dell'ordine (RNF-04); è deterministico, quindi non va
	 * memorizzato per essere ricalcolato; ed è lungo 32 byte, la dimensione
	 * che il contratto di inoltro si aspetta. La chiave è derivata, non il
	 * segreto stesso: così il segreto di autenticazione e la chiave dei
	 * riferimenti restano distinti pur avendo un'unica origine.
	 */
	public static function order_ref( $order_id ) {
		$secret = (string) get_option( 'wcsdi_watcher_secret', '' );
		$chiave = hash_hmac( 'sha256', 'wcsdi-order-ref-key', $secret, true );
		return '0x' . hash_hmac( 'sha256', 'wcsdi-order:' . (int) $order_id, $chiave );
	}

	/**
	 * Avvio del pagamento (RF-02): ordine in pending e coordinate al cliente.
	 *
	 * Non c'è nessuna registrazione da comunicare al servizio di rilevamento:
	 * ogni evento emesso dal contratto di inoltro è per definizione un incasso
	 * di questo negozio, e il riferimento viaggia dentro l'evento stesso.
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );

		$ref   = self::order_ref( $order_id );
		$chain = (string) $this->get_option( 'chain' );

		$order->update_status( 'pending', __( 'In attesa del pagamento on-chain in EURe.', 'wc-stablecoin-sdi' ) );
		$order->update_meta_data( '_wcsdi_order_ref', $ref );
		$order->update_meta_data( '_wcsdi_chain', $chain );
		$order->update_meta_data( '_wcsdi_chain_id_atteso', self::chain_id( $chain ) );
		$order->update_meta_data( '_wcsdi_token', $this->get_option( 'token_address' ) );
		$order->update_meta_data( '_wcsdi_forwarder', $this->get_option( 'forwarder_address' ) );
		$order->update_meta_data( '_wcsdi_receive_address', $this->get_option( 'receive_address' ) );
		$order->update_meta_data( '_wcsdi_expected_amount', $order->get_total() );
		$order->update_meta_data( '_wcsdi_expires_at', time() + ( (int) $this->get_option( 'payment_window', 60 ) * MINUTE_IN_SECONDS ) );
		$order->save();

		// t0: origine di tutte le latenze misurate.
		WCSDI_Misure::segna( $order, 't0' );
		$order->save();

		// Oltre la finestra l'ordine va chiuso restituendo l'eventuale
		// incasso parziale (RF-04).
		WCSDI_Scadenza::pianifica( $order );

		return array(
			'result'   => 'success',
			'redirect' => $this->get_return_url( $order ),
		);
	}

	/**
	 * Istruzioni di pagamento: pagina di ringraziamento, area riservata ed
	 * email dell'ordine in attesa. Il cliente deve poter copiare senza
	 * ambiguità tutto ciò che un portafoglio o una pagina di pagamento
	 * richiede: rete e suo identificativo, contratto del token, contratto da
	 * invocare con la firma della funzione, importo in euro e in unità
	 * minime, riferimento e termine di validità.
	 */
	public function thankyou_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $this->id !== $order->get_payment_method() ) {
			return;
		}
		if ( ! $order->has_status( 'pending' ) ) {
			return;
		}

		$chain    = (string) $order->get_meta( '_wcsdi_chain' );
		$reti     = self::reti();
		$importo  = (string) $order->get_meta( '_wcsdi_expected_amount' );
		$scadenza = (int) $order->get_meta( '_wcsdi_expires_at' );
		$token    = (string) $order->get_meta( '_wcsdi_token' );
		$minime   = self::unita_minime( $importo, 18 );

		echo '<section class="wcsdi-istruzioni">';
		echo '<style>.wcsdi-istruzioni code{overflow-wrap:anywhere;word-break:break-all;font-family:monospace}.wcsdi-istruzioni dt{font-weight:600;margin-top:.6em}</style>';
		echo '<h2>' . esc_html__( 'Completa il pagamento in EURe', 'wc-stablecoin-sdi' ) . '</h2>';
		echo '<p>' . esc_html__( 'Dal tuo portafoglio, autorizza l\'importo sul contratto del token e invoca la funzione pay del contratto di inoltro con il riferimento dell\'ordine, oppure usa una pagina di pagamento che lo faccia per te. Non inviare EURe con un trasferimento semplice: non verrebbero attribuiti né restituiti. La conferma è automatica.', 'wc-stablecoin-sdi' ) . '</p>';
		echo '<dl>';
		echo '<dt>' . esc_html__( 'Rete', 'wc-stablecoin-sdi' ) . '</dt><dd>' . esc_html( isset( $reti[ $chain ] ) ? $reti[ $chain ] : $chain ) . ' (chain id ' . esc_html( (string) self::chain_id( $chain ) ) . ')</dd>';
		if ( '' !== $token ) {
			echo '<dt>' . esc_html__( 'Contratto del token EURe (per l\'autorizzazione)', 'wc-stablecoin-sdi' ) . '</dt><dd><code>' . esc_html( $token ) . '</code></dd>';
		}
		echo '<dt>' . esc_html__( 'Contratto di inoltro da invocare', 'wc-stablecoin-sdi' ) . '</dt><dd><code>' . esc_html( (string) $order->get_meta( '_wcsdi_forwarder' ) ) . '</code><br><small>' . esc_html__( 'funzione', 'wc-stablecoin-sdi' ) . ' <code>pay(bytes32 orderRef, uint256 amount)</code></small></dd>';
		echo '<dt>' . esc_html__( 'Importo', 'wc-stablecoin-sdi' ) . '</dt><dd>' . wp_kses_post( wc_price( (float) $importo, array( 'currency' => 'EUR' ) ) ) . ' = ' . esc_html( wc_format_decimal( $importo, 2 ) ) . ' EURe<br><small>' . esc_html__( 'in unità minime (18 decimali):', 'wc-stablecoin-sdi' ) . ' <code>' . esc_html( $minime ) . '</code></small></dd>';
		echo '<dt>' . esc_html__( 'Riferimento ordine (orderRef)', 'wc-stablecoin-sdi' ) . '</dt><dd><code>' . esc_html( (string) $order->get_meta( '_wcsdi_order_ref' ) ) . '</code></dd>';
		echo '</dl>';
		if ( $scadenza > 0 ) {
			printf(
				'<p>%s</p>',
				esc_html( sprintf(
					/* translators: 1: data e ora di scadenza, 2: fuso orario */
					__( 'Il riferimento resta valido fino alle %1$s (%2$s). La conferma richiede il tempo del criterio di finalità configurato: fino a una ventina di minuti.', 'wc-stablecoin-sdi' ),
					wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $scadenza ),
					wp_timezone_string()
				) )
			);
		}
		echo '<p><small>' . esc_html__( 'Il costo di rete è a tuo carico ed è pagato alla rete, non all\'esercente.', 'wc-stablecoin-sdi' ) . '</small></p>';
		echo '</section>';
	}

	/** Importo decimale in unità minime del token, senza aritmetica in virgola mobile. */
	public static function unita_minime( $importo, $decimali ) {
		$importo = trim( (string) $importo );
		if ( ! preg_match( '/^(\d+)(?:\.(\d+))?$/', $importo, $m ) ) {
			return '';
		}
		$intera  = ltrim( $m[1], '0' );
		$frazione = isset( $m[2] ) ? substr( str_pad( $m[2], $decimali, '0' ), 0, $decimali ) : str_repeat( '0', $decimali );
		$valore  = ltrim( $intera . $frazione, '0' );
		return '' === $valore ? '0' : $valore;
	}
}
