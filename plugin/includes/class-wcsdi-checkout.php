<?php
/**
 * Raccolta dei dati fiscali del cessionario al checkout.
 *
 * Il composer della fattura (WCSDI_Fattura) legge da tempo i metadati
 * dell'ordine _wcsdi_codice_fiscale, _wcsdi_piva, _wcsdi_codice_destinatario e
 * _wcsdi_pec, ma nessuno li scriveva: senza questi dati il Sistema di
 * Interscambio scarta la fattura con il controllo 00417 (dati del cessionario
 * mancanti o incompleti). Questa classe li raccoglie al checkout, sia
 * classico sia a blocchi, li normalizza e li salva sull'ordine.
 *
 * I campi compaiono per qualsiasi metodo di pagamento, perché sono dati
 * fiscali e non hanno legame col metodo scelto. La validazione stretta
 * (obbligatorietà, formato, carattere di controllo) si applica invece solo
 * quando il metodo scelto è wcsdi_eure: gli altri metodi eventualmente
 * attivi sul negozio non riguardano questo plugin e non devono subirne i
 * vincoli.
 */

defined( 'ABSPATH' ) || exit;

final class WCSDI_Checkout {

	/**
	 * Tabella dei valori per posizione dispari nel calcolo del carattere di
	 * controllo del codice fiscale (algoritmo ufficiale dell'Agenzia delle
	 * Entrate). Contempla già le lettere usate nell'omocodia (L,M,N,P,Q,R,S,
	 * T,U,V al posto delle cifre), perché la tabella copre tutto l'alfabeto.
	 */
	private const VALORI_DISPARI = array(
		'0' => 1,  '1' => 0,  '2' => 5,  '3' => 7,  '4' => 9,
		'5' => 13, '6' => 15, '7' => 17, '8' => 19, '9' => 21,
		'A' => 1,  'B' => 0,  'C' => 5,  'D' => 7,  'E' => 9,
		'F' => 13, 'G' => 15, 'H' => 17, 'I' => 19, 'J' => 21,
		'K' => 2,  'L' => 4,  'M' => 18, 'N' => 20, 'O' => 11,
		'P' => 3,  'Q' => 6,  'R' => 8,  'S' => 12, 'T' => 14,
		'U' => 16, 'V' => 10, 'W' => 22, 'X' => 25, 'Y' => 24,
		'Z' => 23,
	);

	/**
	 * Tabella dei valori per posizione pari: qui la conversione è diretta,
	 * lettera per lettera nell'ordine dell'alfabeto e cifra per cifra nel
	 * proprio valore.
	 */
	private const VALORI_PARI = array(
		'0' => 0,  '1' => 1,  '2' => 2,  '3' => 3,  '4' => 4,
		'5' => 5,  '6' => 6,  '7' => 7,  '8' => 8,  '9' => 9,
		'A' => 0,  'B' => 1,  'C' => 2,  'D' => 3,  'E' => 4,
		'F' => 5,  'G' => 6,  'H' => 7,  'I' => 8,  'J' => 9,
		'K' => 10, 'L' => 11, 'M' => 12, 'N' => 13, 'O' => 14,
		'P' => 15, 'Q' => 16, 'R' => 17, 'S' => 18, 'T' => 19,
		'U' => 20, 'V' => 21, 'W' => 22, 'X' => 23, 'Y' => 24,
		'Z' => 25,
	);

	/**
	 * Regex del formato codice fiscale: sei lettere, due caratteri per l'anno,
	 * una lettera fra quelle usate per i mesi, due caratteri per giorno e
	 * sesso, una lettera e tre caratteri per il comune, un carattere di
	 * controllo. Le classi [0-9LMNPQRSTUV] accolgono anche l'omocodia.
	 */
	private const FORMATO_CODICE_FISCALE = '/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/';

	public static function init() {
		add_filter( 'woocommerce_checkout_fields', array( __CLASS__, 'aggiungi_campi_classico' ) );
		add_action( 'woocommerce_checkout_process', array( __CLASS__, 'valida_checkout_classico' ) );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'salva_meta_ordine' ), 10, 2 );

		// Il checkout a blocchi ha una sua API di registrazione dei campi,
		// disponibile solo da WooCommerce 8.9: senza, questa parte resta
		// inerte e il checkout classico funziona comunque.
		add_action( 'woocommerce_init', array( __CLASS__, 'registra_campi_blocchi' ) );
	}

	/* ------------------------------------------------------------------ *
	 * Checkout classico
	 * ------------------------------------------------------------------ */

	/**
	 * Aggiunge i campi fiscali alla sezione billing del checkout classico.
	 */
	public static function aggiungi_campi_classico( $fields ) {
		$fields['billing']['wcsdi_tipo_cliente'] = array(
			'type'     => 'select',
			'label'    => __( 'Tipo cliente', 'wc-stablecoin-sdi' ),
			'options'  => array(
				'privato' => __( 'Privato', 'wc-stablecoin-sdi' ),
				'azienda' => __( 'Azienda o professionista', 'wc-stablecoin-sdi' ),
			),
			'default'  => 'privato',
			'required' => false,
			'priority' => 25,
		);

		$fields['billing']['wcsdi_codice_fiscale'] = array(
			'type'        => 'text',
			'label'       => __( 'Codice fiscale', 'wc-stablecoin-sdi' ),
			'placeholder' => __( '16 caratteri', 'wc-stablecoin-sdi' ),
			'required'    => false,
			'priority'    => 26,
		);

		$fields['billing']['wcsdi_partita_iva'] = array(
			'type'        => 'text',
			'label'       => __( 'Partita IVA', 'wc-stablecoin-sdi' ),
			'placeholder' => __( '11 cifre', 'wc-stablecoin-sdi' ),
			'required'    => false,
			'priority'    => 27,
		);

		$fields['billing']['wcsdi_codice_destinatario'] = array(
			'type'        => 'text',
			'label'       => __( 'Codice destinatario', 'wc-stablecoin-sdi' ),
			'placeholder' => __( '7 caratteri', 'wc-stablecoin-sdi' ),
			'required'    => false,
			'priority'    => 28,
		);

		$fields['billing']['wcsdi_pec'] = array(
			'type'     => 'email',
			'label'    => __( 'PEC', 'wc-stablecoin-sdi' ),
			'required' => false,
			'priority' => 29,
		);

		$fields['billing']['wcsdi_richiedi_fattura'] = array(
			'type'     => 'checkbox',
			'label'    => __( 'Richiedo la fattura', 'wc-stablecoin-sdi' ),
			'default'  => true,
			'required' => false,
			'priority' => 30,
		);

		return $fields;
	}

	/**
	 * Valida i campi fiscali. Agganciata a woocommerce_checkout_process, che
	 * gira prima della creazione dell'ordine: un errore qui blocca il
	 * checkout, come richiesto per un dato che condiziona l'emissione della
	 * fattura.
	 */
	public static function valida_checkout_classico() {
		$dati   = self::campi_da_richiesta( wp_unslash( $_POST ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- WooCommerce verifica il nonce del checkout a monte di questo hook.
		$metodo = self::metodo_scelto();
		$paese  = isset( $_POST['billing_country'] ) ? sanitize_text_field( wp_unslash( $_POST['billing_country'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing

		foreach ( self::valida_campi( $dati, $metodo, $paese ) as $errore ) {
			wc_add_notice( $errore, 'error' );
		}
	}

	/**
	 * Salva i valori normalizzati sull'ordine appena creato. Aggancia
	 * woocommerce_checkout_create_order invece di ...update_order_meta perché
	 * riceve già l'oggetto ordine, senza doverlo ricaricare.
	 */
	public static function salva_meta_ordine( WC_Order $order, $data ) {
		$dati = self::campi_da_richiesta( $data );

		$order->update_meta_data( '_wcsdi_codice_fiscale', $dati['codice_fiscale'] );
		$order->update_meta_data( '_wcsdi_piva', $dati['partita_iva'] );
		$order->update_meta_data( '_wcsdi_codice_destinatario', $dati['codice_destinatario'] );
		$order->update_meta_data( '_wcsdi_pec', $dati['pec'] );
		$order->update_meta_data( '_wcsdi_richiedi_fattura', $dati['richiedi_fattura'] );
		$order->update_meta_data( '_wcsdi_tipo_cliente', $dati['tipo_cliente'] );
	}

	/* ------------------------------------------------------------------ *
	 * Checkout a blocchi
	 * ------------------------------------------------------------------ */

	/**
	 * Registra gli stessi campi per il checkout a blocchi, con l'API
	 * introdotta in WooCommerce 8.9. Un errore di registrazione (ad esempio
	 * per uno schema di campo cambiato in una versione futura) non deve
	 * interrompere il caricamento del resto del plugin.
	 */
	public static function registra_campi_blocchi() {
		if ( ! function_exists( 'woocommerce_register_additional_checkout_field' ) ) {
			return;
		}

		try {
			woocommerce_register_additional_checkout_field(
				array(
					'id'       => 'wcsdi/tipo_cliente',
					'label'    => __( 'Tipo cliente', 'wc-stablecoin-sdi' ),
					'location' => 'contact',
					'type'     => 'select',
					'options'  => array(
						array(
							'value' => 'privato',
							'label' => __( 'Privato', 'wc-stablecoin-sdi' ),
						),
						array(
							'value' => 'azienda',
							'label' => __( 'Azienda o professionista', 'wc-stablecoin-sdi' ),
						),
					),
					'required' => false,
				)
			);

			woocommerce_register_additional_checkout_field(
				array(
					'id'         => 'wcsdi/codice_fiscale',
					'label'      => __( 'Codice fiscale', 'wc-stablecoin-sdi' ),
					'location'   => 'contact',
					'type'       => 'text',
					'required'   => false,
					'attributes' => array(
						'placeholder' => __( '16 caratteri', 'wc-stablecoin-sdi' ),
					),
				)
			);

			woocommerce_register_additional_checkout_field(
				array(
					'id'         => 'wcsdi/partita_iva',
					'label'      => __( 'Partita IVA', 'wc-stablecoin-sdi' ),
					'location'   => 'contact',
					'type'       => 'text',
					'required'   => false,
					'attributes' => array(
						'placeholder' => __( '11 cifre', 'wc-stablecoin-sdi' ),
					),
				)
			);

			woocommerce_register_additional_checkout_field(
				array(
					'id'         => 'wcsdi/codice_destinatario',
					'label'      => __( 'Codice destinatario', 'wc-stablecoin-sdi' ),
					'location'   => 'contact',
					'type'       => 'text',
					'required'   => false,
					'attributes' => array(
						'placeholder' => __( '7 caratteri', 'wc-stablecoin-sdi' ),
					),
				)
			);

			woocommerce_register_additional_checkout_field(
				array(
					'id'       => 'wcsdi/pec',
					'label'    => __( 'PEC', 'wc-stablecoin-sdi' ),
					'location' => 'contact',
					'type'     => 'text',
					'required' => false,
				)
			);

			woocommerce_register_additional_checkout_field(
				array(
					'id'       => 'wcsdi/richiedi_fattura',
					'label'    => __( 'Richiedo la fattura', 'wc-stablecoin-sdi' ),
					'location' => 'contact',
					'type'     => 'checkbox',
					'required' => false,
				)
			);
		} catch ( Exception $e ) {
			// Una versione di WooCommerce con uno schema diverso non deve
			// bloccare il resto del plugin: i campi restano assenti dal
			// checkout a blocchi, il checkout classico funziona comunque.
			return;
		}

		// Validazione di formato campo per campo, per un riscontro immediato
		// nell'interfaccia: non conosce gli altri campi, quindi verifica solo
		// che il valore inserito sia sintatticamente corretto.
		foreach ( array( 'codice_fiscale', 'partita_iva', 'codice_destinatario', 'pec' ) as $campo ) {
			add_action( "woocommerce_blocks_validate_additional_field_wcsdi/{$campo}", array( __CLASS__, 'valida_formato_campo_blocchi' ), 10, 2 );
		}

		// Validazione d'insieme (obbligatorietà secondo tipo cliente e
		// paese): riceve tutti i campi della location "contact" insieme, la
		// sola che li conosca tutti nello stesso momento.
		add_action( 'woocommerce_blocks_validate_location_contact_fields', array( __CLASS__, 'valida_campi_blocchi' ), 10, 3 );

		// Copia i valori nei metadati dell'ordine, uno per volta: è così che
		// l'API dei campi aggiuntivi comunica ogni valore raccolto.
		add_action( 'woocommerce_set_additional_field_value', array( __CLASS__, 'salva_campo_blocchi' ), 10, 4 );
	}

	/**
	 * Verifica il formato di un singolo campo. Il nome del campo si ricava
	 * dal filtro corrente perché la stessa funzione serve tutti e quattro i
	 * campi validabili in isolamento.
	 */
	public static function valida_formato_campo_blocchi( WP_Error $errors, $field_value ) {
		if ( '' === trim( (string) $field_value ) ) {
			return; // Campo vuoto: l'eventuale obbligatorietà si verifica altrove, con gli altri campi a disposizione.
		}

		$campo = str_replace( 'woocommerce_blocks_validate_additional_field_wcsdi/', '', current_filter() );

		switch ( $campo ) {
			case 'codice_fiscale':
				if ( ! self::codice_fiscale_valido( $field_value ) ) {
					$errors->add( 'wcsdi_codice_fiscale', __( 'Il codice fiscale indicato non è valido.', 'wc-stablecoin-sdi' ) );
				}
				break;
			case 'partita_iva':
				if ( ! self::partita_iva_valida( $field_value ) ) {
					$errors->add( 'wcsdi_partita_iva', __( 'La partita IVA indicata non è valida.', 'wc-stablecoin-sdi' ) );
				}
				break;
			case 'codice_destinatario':
				if ( ! self::codice_destinatario_valido( $field_value ) ) {
					$errors->add( 'wcsdi_codice_destinatario', __( 'Il codice destinatario deve essere di 7 caratteri alfanumerici.', 'wc-stablecoin-sdi' ) );
				}
				break;
			case 'pec':
				if ( ! is_email( (string) $field_value ) ) {
					$errors->add( 'wcsdi_pec', __( 'L\'indirizzo PEC indicato non è valido.', 'wc-stablecoin-sdi' ) );
				}
				break;
		}
	}

	/**
	 * Validazione d'insieme dei campi fiscali per il checkout a blocchi:
	 * stessa logica del checkout classico, applicata ai campi della location
	 * "contact".
	 */
	public static function valida_campi_blocchi( WP_Error $errors, $fields, $group ) {
		if ( 'contact' !== $group || ! is_array( $fields ) ) {
			return;
		}

		$dati   = self::campi_da_richiesta( $fields );
		$metodo = self::metodo_scelto();
		$paese  = WC()->customer ? WC()->customer->get_billing_country() : '';

		foreach ( self::valida_campi( $dati, $metodo, $paese ) as $messaggio ) {
			$errors->add( 'wcsdi_dati_fiscali', $messaggio );
		}
	}

	/**
	 * Copia un campo aggiuntivo nei metadati dell'ordine. L'API dei campi
	 * aggiuntivi chiama questa azione una volta per campo: non c'è un unico
	 * punto con tutti i valori insieme, a differenza del checkout classico.
	 */
	public static function salva_campo_blocchi( $key, $value, $group, $wc_object ) {
		if ( 'contact' !== $group || ! $wc_object instanceof WC_Order ) {
			return;
		}

		$mappa = array(
			'wcsdi/tipo_cliente'        => '_wcsdi_tipo_cliente',
			'wcsdi/codice_fiscale'      => '_wcsdi_codice_fiscale',
			'wcsdi/partita_iva'         => '_wcsdi_piva',
			'wcsdi/codice_destinatario' => '_wcsdi_codice_destinatario',
			'wcsdi/pec'                 => '_wcsdi_pec',
			'wcsdi/richiedi_fattura'    => '_wcsdi_richiedi_fattura',
		);

		if ( ! isset( $mappa[ $key ] ) ) {
			return;
		}

		// Le chiavi restituite da campi_da_richiesta coincidono con il nome
		// del campo senza il prefisso "wcsdi/": si riusa la stessa
		// normalizzazione del checkout classico passandole un array di un
		// solo elemento.
		$campo = str_replace( 'wcsdi/', '', $key );
		$dati  = self::campi_da_richiesta( array( $key => $value ) );

		$wc_object->update_meta_data( $mappa[ $key ], $dati[ $campo ] );
	}

	/* ------------------------------------------------------------------ *
	 * Regole di validazione, comuni ai due checkout
	 * ------------------------------------------------------------------ */

	/**
	 * Applica le regole di obbligatorietà e formato. Restituisce l'elenco dei
	 * messaggi d'errore, vuoto se tutto è a posto.
	 */
	private static function valida_campi( array $dati, $metodo, $paese ) {
		$errori = array();

		if ( 'wcsdi_eure' !== $metodo ) {
			// La validazione stretta riguarda solo il pagamento in EURe: gli
			// altri metodi non hanno legame con la fatturazione via SdI.
			return $errori;
		}

		$paese = strtoupper( trim( (string) $paese ) );

		if ( '' !== $paese && 'IT' !== $paese ) {
			$lunghezza = strlen( $dati['partita_iva'] );
			if ( $lunghezza < 2 || $lunghezza > 28 ) {
				$errori[] = __( 'Per un cessionario non stabilito in Italia indica l\'identificativo fiscale del tuo paese nel campo partita IVA.', 'wc-stablecoin-sdi' );
			}
			return $errori;
		}

		if ( 'azienda' === $dati['tipo_cliente'] ) {
			if ( '' === $dati['partita_iva'] || ! self::partita_iva_valida( $dati['partita_iva'] ) ) {
				$errori[] = __( 'Indica una partita IVA valida di 11 cifre.', 'wc-stablecoin-sdi' );
			}
			if ( '' !== $dati['codice_fiscale'] && ! self::codice_fiscale_valido( $dati['codice_fiscale'] ) ) {
				$errori[] = __( 'Il codice fiscale indicato non è valido.', 'wc-stablecoin-sdi' );
			}
			if ( '' !== $dati['codice_destinatario'] && ! self::codice_destinatario_valido( $dati['codice_destinatario'] ) ) {
				$errori[] = __( 'Il codice destinatario deve essere di 7 caratteri alfanumerici.', 'wc-stablecoin-sdi' );
			}
			if ( '' !== $dati['pec'] && ! is_email( $dati['pec'] ) ) {
				$errori[] = __( 'L\'indirizzo PEC indicato non è valido.', 'wc-stablecoin-sdi' );
			}
		} elseif ( 'yes' === $dati['richiedi_fattura'] && ( '' === $dati['codice_fiscale'] || ! self::codice_fiscale_valido( $dati['codice_fiscale'] ) ) ) {
			$errori[] = __( 'Per ricevere la fattura indica un codice fiscale valido.', 'wc-stablecoin-sdi' );
		}

		return $errori;
	}

	/**
	 * Il metodo di pagamento scelto: dal corpo della richiesta nel checkout
	 * classico, dalla sessione altrimenti. La sessione è l'unica fonte
	 * disponibile nella validazione a campo del checkout a blocchi, che non
	 * riceve il metodo fra i parametri.
	 */
	private static function metodo_scelto() {
		if ( isset( $_POST['payment_method'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing
			return sanitize_text_field( wp_unslash( $_POST['payment_method'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		}
		if ( function_exists( 'WC' ) && WC()->session ) {
			return (string) WC()->session->get( 'chosen_payment_method' );
		}
		return '';
	}

	/* ------------------------------------------------------------------ *
	 * Estrazione e normalizzazione, riusate da entrambi i checkout
	 * ------------------------------------------------------------------ */

	/**
	 * Estrae e normalizza i sei campi da un array di dati grezzi: i dati del
	 * checkout classico (da $_POST o dall'array posted_data di WooCommerce)
	 * oppure i campi del checkout a blocchi, con le chiavi "wcsdi/...". Un
	 * solo punto di normalizzazione evita che le due strade divergano.
	 */
	public static function campi_da_richiesta( $dati ) {
		$dati = is_array( $dati ) ? $dati : array();

		$tipo_cliente = self::valore( $dati, 'tipo_cliente' );
		$tipo_cliente = in_array( $tipo_cliente, array( 'privato', 'azienda' ), true ) ? $tipo_cliente : 'privato';

		$richiedi_fattura = self::valore( $dati, 'richiedi_fattura' );
		$richiedi_fattura = ( ! empty( $richiedi_fattura ) && '0' !== $richiedi_fattura ) ? 'yes' : 'no';

		return array(
			'tipo_cliente'        => $tipo_cliente,
			'codice_fiscale'      => self::normalizza( self::valore( $dati, 'codice_fiscale' ) ),
			'partita_iva'         => self::normalizza( self::valore( $dati, 'partita_iva' ) ),
			'codice_destinatario' => self::normalizza( self::valore( $dati, 'codice_destinatario' ) ),
			'pec'                 => sanitize_email( (string) self::valore( $dati, 'pec' ) ),
			'richiedi_fattura'    => $richiedi_fattura,
		);
	}

	/**
	 * Legge un campo dall'array grezzo, accettando sia la chiave del checkout
	 * classico ("wcsdi_campo") sia quella del checkout a blocchi
	 * ("wcsdi/campo").
	 */
	private static function valore( array $dati, $chiave ) {
		if ( isset( $dati[ 'wcsdi_' . $chiave ] ) ) {
			return $dati[ 'wcsdi_' . $chiave ];
		}
		if ( isset( $dati[ 'wcsdi/' . $chiave ] ) ) {
			return $dati[ 'wcsdi/' . $chiave ];
		}
		return '';
	}

	/**
	 * Normalizzazione comune a codice fiscale, partita IVA e codice
	 * destinatario: maiuscolo, senza spazi.
	 */
	private static function normalizza( $valore ) {
		$valore = sanitize_text_field( (string) $valore );
		return strtoupper( str_replace( ' ', '', $valore ) );
	}

	/* ------------------------------------------------------------------ *
	 * Validazione di formato, pubbliche e riusabili
	 * ------------------------------------------------------------------ */

	/**
	 * Verifica un codice fiscale italiano: 16 caratteri nello schema
	 * alfanumerico previsto, con carattere di controllo corretto secondo
	 * l'algoritmo dell'Agenzia delle Entrate. Le tabelle usate coprono anche
	 * l'omocodia. Accetta inoltre una partita IVA di 11 cifre, che le società
	 * usano come proprio codice fiscale numerico.
	 */
	public static function codice_fiscale_valido( $cf ) {
		$cf = strtoupper( str_replace( ' ', '', (string) $cf ) );

		if ( preg_match( '/^[0-9]{11}$/', $cf ) ) {
			return self::partita_iva_valida( $cf );
		}

		if ( 16 !== strlen( $cf ) || ! preg_match( self::FORMATO_CODICE_FISCALE, $cf ) ) {
			return false;
		}

		$somma = 0;
		for ( $i = 0; $i < 15; $i++ ) {
			$carattere = $cf[ $i ];
			$somma    += ( 0 === $i % 2 ) ? self::VALORI_DISPARI[ $carattere ] : self::VALORI_PARI[ $carattere ];
		}

		$controllo_atteso = chr( 65 + ( $somma % 26 ) );

		return $cf[15] === $controllo_atteso;
	}

	/**
	 * Verifica una partita IVA italiana: 11 cifre, con carattere di controllo
	 * secondo l'algoritmo ufficiale (le cifre in posizione dispari si sommano
	 * come sono, quelle in posizione pari raddoppiate e con 9 sottratto se il
	 * risultato supera 9; il totale, cifra di controllo compresa, deve essere
	 * un multiplo di 10).
	 */
	public static function partita_iva_valida( $piva ) {
		$piva = str_replace( ' ', '', (string) $piva );

		if ( ! preg_match( '/^[0-9]{11}$/', $piva ) ) {
			return false;
		}

		$somma = 0;
		for ( $i = 0; $i < 10; $i++ ) {
			$cifra = (int) $piva[ $i ];
			if ( 0 === $i % 2 ) {
				$somma += $cifra;
			} else {
				$cifra *= 2;
				$somma += $cifra > 9 ? $cifra - 9 : $cifra;
			}
		}
		$somma += (int) $piva[10];

		return 0 === $somma % 10;
	}

	/**
	 * Verifica un codice destinatario: 7 caratteri alfanumerici maiuscoli,
	 * oppure vuoto (il codice non è comunque obbligatorio: la fattura ricade
	 * sul codice generico per i consumatori quando manca).
	 */
	public static function codice_destinatario_valido( $codice ) {
		$codice = strtoupper( str_replace( ' ', '', (string) $codice ) );

		if ( '' === $codice ) {
			return true;
		}

		return 1 === preg_match( '/^[A-Z0-9]{7}$/', $codice );
	}
}
