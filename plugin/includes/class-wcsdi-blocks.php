<?php
/**
 * Integrazione del gateway nel checkout a blocchi (RNF-05).
 *
 * Il checkout classico compone il modulo lato server e trova il gateway dalla
 * sua definizione PHP. Quello a blocchi lo costruisce nel browser e conosce
 * solo i metodi dichiarati attraverso questa interfaccia: senza, il pagamento
 * in EURe semplicemente non compare fra le opzioni.
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class WCSDI_Blocks extends AbstractPaymentMethodType {

	protected $name = 'wcsdi_eure';

	public function initialize() {
		$this->settings = get_option( 'woocommerce_wcsdi_eure_settings', array() );
	}

	public function is_active() {
		return ! empty( $this->settings['enabled'] ) && 'yes' === $this->settings['enabled'];
	}

	public function get_payment_method_script_handles() {
		$handle  = 'wcsdi-blocks';
		$rel     = 'assets/js/blocks.js';
		$percorso = WCSDI_PLUGIN_DIR . $rel;

		wp_register_script(
			$handle,
			plugins_url( $rel, WCSDI_PLUGIN_DIR . 'wc-stablecoin-sdi.php' ),
			array( 'wc-blocks-registry', 'wp-element', 'wp-html-entities', 'wc-settings' ),
			// La versione segue il file, non il plugin: così una modifica allo
			// script invalida la cache del browser anche fra due versioni.
			file_exists( $percorso ) ? (string) filemtime( $percorso ) : WCSDI_VERSION,
			true
		);

		return array( $handle );
	}

	/**
	 * Dati passati allo script. Solo quanto serve a disegnare la voce di
	 * pagamento: nessuna credenziale e nessun indirizzo, che non hanno ragione
	 * di raggiungere il browser.
	 */
	public function get_payment_method_data() {
		return array(
			'title'       => isset( $this->settings['title'] ) ? $this->settings['title'] : __( 'Paga in EURe', 'wc-stablecoin-sdi' ),
			'description' => isset( $this->settings['description'] ) ? $this->settings['description'] : '',
			'supports'    => $this->get_supported_features(),
		);
	}

	public function get_supported_features() {
		$gateways = WC()->payment_gateways()->payment_gateways();
		return isset( $gateways[ $this->name ] )
			? array_filter( $gateways[ $this->name ]->supports, 'is_string' )
			: array( 'products' );
	}
}
