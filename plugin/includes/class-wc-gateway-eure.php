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
					'ethereum' => 'Ethereum',
					'polygon'  => 'Polygon',
					'gnosis'   => 'Gnosis',
				),
				'default'     => 'gnosis',
				'description' => 'Rete su cui accettare EURe. Indirizzo del contratto risolto via API emittente.',
			),
			'receive_address' => array(
				'title'       => 'Indirizzo di incasso',
				'type'        => 'text',
				'description' => 'Indirizzo in controllo esclusivo dell\'esercente, collegato all\'IBAN in fase di onboarding presso l\'emittente (RNF-02).',
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
			'redemption_section' => array( 'title' => 'Conversione automatica in EUR (Monerium)', 'type' => 'title' ),
			'auto_redeem'        => array(
				'title'   => 'Redemption automatica',
				'type'    => 'checkbox',
				'label'   => 'Esegui il rimborso in EUR (SEPA) alla conferma del pagamento',
				'default' => 'yes',
			),
			'monerium_client_id'     => array( 'title' => 'Monerium Client ID', 'type' => 'text' ),
			'monerium_client_secret' => array( 'title' => 'Monerium Client Secret', 'type' => 'password' ),

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
	 * Avvio del pagamento (RF-02): ordine in pending, coordinate al cliente.
	 * TODO(cap.5): pagina di pagamento con importo, indirizzo, QR, countdown
	 * della finestra e stato live; registrazione dell'ordine presso il watcher.
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );

		$order->update_status( 'pending', 'In attesa del pagamento on-chain in EURe.' );
		$order->update_meta_data( '_wcsdi_receive_address', $this->get_option( 'receive_address' ) );
		$order->update_meta_data( '_wcsdi_expected_amount', $order->get_total() );
		$order->save();

		// WC svuota il carrello e reindirizza; la pagina di ringraziamento
		// ospiterà le istruzioni di pagamento (fase Capitolo 5).
		return array(
			'result'   => 'success',
			'redirect' => $this->get_return_url( $order ),
		);
	}
}
