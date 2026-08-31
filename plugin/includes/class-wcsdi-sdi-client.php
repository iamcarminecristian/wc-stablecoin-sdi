<?php
/**
 * Client del fornitore accreditato per la trasmissione al SdI (RF-06, RF-07).
 *
 * Il fornitore fa da intermediario verso il Sistema di Interscambio: riceve il
 * documento, lo valida, lo inoltra e raccoglie le notifiche. Il plugin non
 * parla mai direttamente con il SdI.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_SdI_Client {

	/** @var string */
	private $base_url;

	/** @var string */
	private $token;

	public function __construct( $base_url, $token ) {
		$this->base_url = untrailingslashit( $base_url );
		$this->token    = $token;
	}

	/**
	 * Trasmette la fattura e restituisce l'identificativo assegnato.
	 *
	 * @param string $xml Documento prodotto da WCSDI_Fattura::componi().
	 * @return array{uuid:string, marking:string}
	 * @throws WCSDI_SdI_Exception Se la trasmissione non riesce.
	 */
	public function trasmetti( $xml ) {
		$risposta = $this->richiesta( 'POST', '/invoices', $xml );
		$dati     = isset( $risposta['data'] ) ? $risposta['data'] : array();

		if ( empty( $dati['uuid'] ) ) {
			throw new WCSDI_SdI_Exception(
				'Risposta priva di identificativo: ' . wp_json_encode( $risposta ),
				false
			);
		}

		return array(
			'uuid'    => (string) $dati['uuid'],
			'marking' => isset( $dati['marking'] ) ? (string) $dati['marking'] : 'sent',
		);
	}

	/**
	 * Rilegge lo stato di una fattura già trasmessa e le notifiche del SdI.
	 *
	 * @return array{marking:string, notifications:array, notice:?string}
	 */
	public function stato( $uuid ) {
		$risposta = $this->richiesta( 'GET', '/invoices/' . rawurlencode( $uuid ) );
		$dati     = isset( $risposta['data'] ) ? $risposta['data'] : array();

		return array(
			'marking'       => isset( $dati['marking'] ) ? (string) $dati['marking'] : '',
			'notifications' => isset( $dati['notifications'] ) && is_array( $dati['notifications'] )
				? $dati['notifications'] : array(),
			'notice'        => isset( $dati['notice'] ) ? $dati['notice'] : null,
		);
	}

	/**
	 * Rilegge le sole notifiche di una fattura dall'endpoint dedicato.
	 *
	 * È la seconda delle due strade che il fornitore documenta per conoscere
	 * l'esito presso il SdI: l'altra è la registrazione di una callback, che
	 * presuppone un'installazione raggiungibile dall'esterno e quindi non è
	 * praticabile per un'installazione locale. Le due fonti dovrebbero
	 * coincidere; si interroga anche questa perché il campo incorporato nella
	 * risposta della fattura può restare vuoto senza che ciò distingua «non ci
	 * sono notifiche» da «questa risposta non le riporta».
	 *
	 * L'identificativo va nel percorso: passato come parametro di query il
	 * servizio risponde 400 «uuid is required».
	 *
	 * @return array Elenco delle notifiche, vuoto se non ve ne sono.
	 */
	public function notifiche( $uuid ) {
		$risposta = $this->richiesta( 'GET', '/invoices_notifications/' . rawurlencode( $uuid ) );
		$dati     = isset( $risposta['data'] ) ? $risposta['data'] : array();

		return is_array( $dati ) ? $dati : array();
	}

	/**
	 * Esegue la chiamata distinguendo i guasti transitori da quelli definitivi.
	 *
	 * La distinzione è la parte che conta: un documento scartato per dati
	 * errati non migliora riprovando e va portato all'attenzione
	 * dell'esercente, mentre un servizio momentaneamente irraggiungibile va
	 * riprovato senza disturbare nessuno (RF-07).
	 */
	private function richiesta( $metodo, $percorso, $corpo = null ) {
		$headers = array(
			'Authorization' => 'Bearer ' . $this->token,
			'Accept'        => 'application/json',
		);
		// Il documento viaggia come XML nel corpo della richiesta. Il servizio
		// restituisce poi la fattura in forma di struttura JSON, ma non la
		// accetta in quella forma: inviarla come JSON produce un errore di
		// parsing con codice 802.
		if ( null !== $corpo ) {
			$headers['Content-Type'] = 'application/xml';
		}

		$args = array(
			'method'  => $metodo,
			'timeout' => 30,
			'headers' => $headers,
		);
		if ( null !== $corpo ) {
			$args['body'] = $corpo;
		}

		$risposta = wp_remote_request( $this->base_url . $percorso, $args );

		if ( is_wp_error( $risposta ) ) {
			// Rete irraggiungibile o timeout: transitorio per definizione.
			throw new WCSDI_SdI_Exception( $risposta->get_error_message(), true );
		}

		$codice = (int) wp_remote_retrieve_response_code( $risposta );
		$grezzo = wp_remote_retrieve_body( $risposta );

		if ( $codice >= 200 && $codice < 300 ) {
			$decodificato = json_decode( $grezzo, true );
			if ( null === $decodificato ) {
				throw new WCSDI_SdI_Exception( 'Risposta non interpretabile come JSON', true );
			}
			return $decodificato;
		}

		// 429 e 5xx dipendono dal servizio, non dal documento: si riprova.
		// 4xx significa che la richiesta è sbagliata e resterà sbagliata.
		$transitorio = ( 429 === $codice || $codice >= 500 );

		throw new WCSDI_SdI_Exception(
			sprintf( 'HTTP %d su %s %s: %s', $codice, $metodo, $percorso, substr( $grezzo, 0, 500 ) ),
			$transitorio
		);
	}
}

/**
 * Errore di trasmissione, con l'indicazione se abbia senso riprovare.
 */
class WCSDI_SdI_Exception extends Exception {

	/** @var bool */
	private $transitorio;

	public function __construct( $messaggio, $transitorio ) {
		parent::__construct( $messaggio );
		$this->transitorio = (bool) $transitorio;
	}

	public function e_transitorio() {
		return $this->transitorio;
	}
}
