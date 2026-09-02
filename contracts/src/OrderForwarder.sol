// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// Interfaccia minima dell'ERC-20, limitata a cio' che serve all'inoltro.
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// Estensione EIP-2612, supportata dal contratto EURe di Monerium.
interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title  Inoltro di pagamenti EURe con riferimento all'ordine
/// @notice Risolve la correlazione tra pagamento on-chain e ordine WooCommerce.
///
/// Il problema: l'emittente lega l'IBAN di accredito a un unico indirizzo, quindi
/// l'esercente non puo' assegnare un indirizzo distinto a ogni ordine, e un
/// trasferimento ERC-20 non trasporta alcuna causale. Due ordini di pari importo
/// nella stessa finestra temporale sarebbero indistinguibili.
///
/// La soluzione: il cliente non trasferisce direttamente, ma invoca questo
/// contratto indicando il riferimento dell'ordine. Il contratto sposta i token
/// dal cliente all'esercente ed emette un evento che porta con se' quel
/// riferimento, rendendo la correlazione esatta e verificabile on-chain.
///
/// @dev Il contratto non custodisce nulla: `transferFrom` sposta i token
/// direttamente dal cliente all'esercente, senza che transitino mai per il
/// bilancio di questo contratto, nemmeno all'interno della chiamata. Non
/// espone funzioni di prelievo perche' non ha nulla da prelevare, e non ha
/// proprietario ne' funzioni amministrative. Attua RNF-02 in senso stretto.
contract OrderForwarder {
    /// Token accettato, fissato alla costruzione: un contratto per token e rete.
    IERC20 public immutable token;

    /// Indirizzo di incasso dell'esercente, quello collegato all'IBAN presso
    /// l'emittente. Immutabile: cambiarlo richiede un nuovo deploy, cosi' che
    /// nessuno possa dirottare gli incassi di un contratto gia' pubblicato.
    address public immutable merchant;

    /// @param orderRef riferimento opaco dell'ordine, indicizzato per
    /// permettere al servizio di rilevamento di filtrare i log per singolo
    /// ordine. Il plugin vi deriva un valore non riconducibile al cliente,
    /// in attuazione di RNF-04.
    event OrderPaid(bytes32 indexed orderRef, address indexed payer, uint256 amount);

    error IndirizzoNullo();
    error ImportoNullo();
    error RiferimentoNullo();
    error TrasferimentoFallito();

    constructor(address token_, address merchant_) {
        if (token_ == address(0) || merchant_ == address(0)) revert IndirizzoNullo();
        token = IERC20(token_);
        merchant = merchant_;
    }

    /// Pagamento in due transazioni: il cliente ha gia' autorizzato l'importo
    /// con `approve` sul token.
    function pay(bytes32 orderRef, uint256 amount) external {
        _forward(orderRef, amount);
    }

    /// Pagamento in una sola transazione: l'autorizzazione viaggia come firma
    /// EIP-2612, quindi al cliente basta una firma off-chain e una transazione.
    ///
    /// @dev Il permit e' in try/catch di proposito. Chi vede una firma di
    /// permit prima della sua inclusione puo' anticiparla eseguendola per
    /// primo (su una rete con sequencer unico e mempool privata quel "chi"
    /// e' l'operatore stesso, ma il contratto non fa affidamento su questo):
    /// il permit fallirebbe per nonce gia' consumato e trascinerebbe con se'
    /// l'intero pagamento, pur essendo l'autorizzazione ormai concessa. Si
    /// ignora quindi l'esito del permit e si lascia decidere all'allowance
    /// effettiva, verificata da `_forward`.
    function payWithPermit(
        bytes32 orderRef,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {
            // autorizzazione concessa da questa chiamata
        } catch {
            // gia' concessa altrove: si prosegue e decide l'allowance
        }
        _forward(orderRef, amount);
    }

    function _forward(bytes32 orderRef, uint256 amount) private {
        if (orderRef == bytes32(0)) revert RiferimentoNullo();
        if (amount == 0) revert ImportoNullo();

        // Il valore di ritorno va controllato. SafeERC20 non serve: il token
        // e' fissato alla costruzione e verificato in fase di deploy.
        if (!token.transferFrom(msg.sender, merchant, amount)) revert TrasferimentoFallito();

        emit OrderPaid(orderRef, msg.sender, amount);
    }
}
