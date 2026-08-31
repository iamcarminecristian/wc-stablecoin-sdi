<?php
/**
 * Gateway di pagamento EURe (skeleton di progetto, cfr. tesi §4.1-§4.2).
 *
 * Stato: struttura e superficie di configurazione complete; la logica di
 * pagamento verrà consolidata a valle degli spike 1-3 (Capitolo 5).
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Gateway_EURe extends WC_Payment_Gateway {

	public function __construct() {
		$this->id                 = 'wcsdi_eure';
		$this->method_title       = 'Stablecoin EUR (EURe) + SdI';
		$this->method_description = 'Accetta pagamenti in EURe con conversione automatica in EUR (rimborso alla pari via SEPA) e fatturazione elettronica automatica tramite SdI.';
		$this->has_fields         = false;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
	}

	/**
	 * Superficie di configurazione del merchant (RF-08).
	 * Ogni campo è tracciato sul requisito o sulla sezione di tesi pertinente.
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'     => array(
				'title'   => 'Abilita',
				'type'    => 'checkbox',
				'label'   => 'Abilita il pagamento in EURe',
				'default' => 'no',
			),
			'title'       => array(
				'title'   => 'Titolo al checkout',
				'type'    => 'text',
				'default' => 'Paga in EURe (stablecoin euro)',
			),
			'description' => array(
				'title'   => 'Descrizione al checkout',
				'type'    => 'textarea',
				'default' => 'Trasferisci l\'importo esatto in EURe all\'indirizzo indicato. L\'ordine si conferma automaticamente.',
			),

			// --- Rete e rilevamento (RF-01, RF-03, §4.3) ---
			'network_section' => array( 'title' => 'Rete e rilevamento', 'type' => 'title' ),
			'chain'           => array(
				'title'       => 'Rete',
				'type'        => 'select',
				'options'     => array(
					'gnosis'      => 'Gnosis',
					'ethereum'    => 'Ethereum',
					'polygon'     => 'Polygon',
					'basesepolia' => 'Base Sepolia (rete di prova)',
					'chiado'      => 'Gnosis Chiado (rete di prova)',
				),
				'default'     => 'gnosis',
				'description' => 'Rete su cui accettare EURe. Deve coincidere con la rete su cui e\' pubblicato il contratto di inoltro e con quella collegata all\'IBAN presso l\'emittente.',
			),
			'receive_address' => array(
				'title'       => 'Indirizzo di incasso',
				'type'        => 'text',
				'description' => 'Indirizzo in controllo esclusivo dell\'esercente, collegato all\'IBAN in fase di onboarding presso l\'emittente (RNF-02).',
			),
			'forwarder_address' => array(
				'title'       => 'Contratto di inoltro',
				'type'        => 'text',
				'description' => 'Indirizzo del contratto che riceve i pagamenti e ne registra il riferimento all\'ordine (&sect;4.3). Va pubblicato una tantum sulla rete scelta; senza, i pagamenti non sono attribuibili ai singoli ordini.',
			),
			'confirmations'   => array(
				'title'       => 'Conferme richieste',
				'type'        => 'number',
				'default'     => '12',
				'description' => 'Criterio di finalità per la rete selezionata; i default per rete saranno tarati nel Capitolo 6.',
			),
			'payment_window'  => array(
				'title'       => 'Finestra di pagamento (minuti)',
				'type'        => 'number',
				'default'     => '60',
				'description' => 'Oltre la finestra l\'ordine non pagato passa in failed (RF-04).',
			),

			// --- Conversione automatica (RF-05, §4.4) ---
			// Le credenziali dell'emittente non stanno qui di proposito. Il
			// rimborso richiede la firma dell'indirizzo di incasso, e quella
			// capacita' risiede nel servizio di rilevamento, che e' separato
			// dall'ambiente di esecuzione di WordPress e privo di superficie
			// esposta (§4.4). Il plugin non deve poter firmare nulla.
			'redemption_section' => array(
				'title'       => 'Conversione automatica in EUR (Monerium)',
				'type'        => 'title',
				'description' => 'Si configura nel servizio di rilevamento, non qui: disporre il rimborso richiede una firma dell\'indirizzo di incasso, e il plugin non deve custodire chiavi (RNF-02, &sect;4.4).',
			),

			// --- Fatturazione elettronica (RF-06, RF-07, §4.5) ---
			'sdi_section'   => array( 'title' => 'Fatturazione elettronica (SdI via openapi.it)', 'type' => 'title' ),
			'openapi_token' => array( 'title' => 'openapi.it token', 'type' => 'password' ),
			'cedente_piva'  => array( 'title' => 'Partita IVA cedente', 'type' => 'text' ),
			'cedente_cf'    => array( 'title' => 'Codice fiscale cedente', 'type' => 'text' ),
			'cedente_denominazione' => array( 'title' => 'Denominazione cedente', 'type' => 'text' ),
			'cedente_regime'        => array(
				'title'   => 'Regime fiscale',
				'type'    => 'text',
				'default' => 'RF01',
			),
		);
	}

	/**
	 * Riferimento dell'ordine da comunicare alla catena (RF-02).
	 *
	 * È derivato dall'identificativo dell'ordine tramite HMAC con il segreto
	 * condiviso, per tre ragioni. Non è invertibile da un osservatore esterno,
	 * quindi la catena non espone quanti ordini abbia il negozio né consente di
	 * collegarli fra loro (RNF-04). È deterministico, quindi non va memorizzato
	 * per essere ricalcolato. Ed è lungo 32 byte, la dimensione che il
	 * contratto di inoltro si aspetta.
	 */
	public static function order_ref( $order_id ) {
		$secret = (string) get_option( 'wcsdi_watcher_secret', '' );
		return '0x' . hash_hmac( 'sha256', 'wcsdi-order:' . (int) $order_id, $secret );
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

		$ref = self::order_ref( $order_id );

		$order->update_status( 'pending', 'In attesa del pagamento on-chain in EURe.' );
		$order->update_meta_data( '_wcsdi_order_ref', $ref );
		$order->update_meta_data( '_wcsdi_chain', $this->get_option( 'chain' ) );
		$order->update_meta_data( '_wcsdi_forwarder', $this->get_option( 'forwarder_address' ) );
		$order->update_meta_data( '_wcsdi_receive_address', $this->get_option( 'receive_address' ) );
		$order->update_meta_data( '_wcsdi_expected_amount', $order->get_total() );
		$order->update_meta_data( '_wcsdi_expires_at', time() + ( (int) $this->get_option( 'payment_window', 60 ) * MINUTE_IN_SECONDS ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $this->get_return_url( $order ),
		);
	}

	/**
	 * Istruzioni di pagamento sulla pagina di ringraziamento e nelle email.
	 * Il cliente deve poter copiare senza ambiguità i tre valori che servono
	 * al suo portafoglio: contratto da invocare, importo e riferimento.
	 */
	public function thankyou_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $this->id !== $order->get_payment_method() ) {
			return;
		}
		if ( ! $order->has_status( 'pending' ) ) {
			return;
		}

		$scadenza = (int) $order->get_meta( '_wcsdi_expires_at' );

		echo '<section class="wcsdi-istruzioni">';
		echo '<h2>' . esc_html__( 'Completa il pagamento in EURe', 'wc-stablecoin-sdi' ) . '</h2>';
		echo '<p>' . esc_html__( 'Dal tuo portafoglio, autorizza l\'importo e invoca il contratto indicando il riferimento dell\'ordine. La conferma è automatica: non serve comunicarci nulla.', 'wc-stablecoin-sdi' ) . '</p>';
		echo '<dl>';
		echo '<dt>' . esc_html__( 'Rete', 'wc-stablecoin-sdi' ) . '</dt><dd>' . esc_html( (string) $order->get_meta( '_wcsdi_chain' ) ) . '</dd>';
		echo '<dt>' . esc_html__( 'Contratto', 'wc-stablecoin-sdi' ) . '</dt><dd><code>' . esc_html( (string) $order->get_meta( '_wcsdi_forwarder' ) ) . '</code></dd>';
		echo '<dt>' . esc_html__( 'Importo', 'wc-stablecoin-sdi' ) . '</dt><dd>' . esc_html( (string) $order->get_meta( '_wcsdi_expected_amount' ) ) . ' EURe</dd>';
		echo '<dt>' . esc_html__( 'Riferimento ordine', 'wc-stablecoin-sdi' ) . '</dt><dd><code>' . esc_html( (string) $order->get_meta( '_wcsdi_order_ref' ) ) . '</code></dd>';
		echo '</dl>';
		if ( $scadenza > 0 ) {
			printf(
				'<p>%s</p>',
				esc_html( sprintf(
					/* translators: %s: data e ora di scadenza */
					__( 'Il riferimento resta valido fino alle %s.', 'wc-stablecoin-sdi' ),
					wp_date( 'd/m/Y H:i', $scadenza )
				) )
			);
		}
		echo '</section>';
	}
}
