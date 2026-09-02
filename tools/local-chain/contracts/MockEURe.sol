// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// Token ERC-20 minimale per lo sviluppo locale: simula EURe su anvil.
/// Estende la base ERC-20 con EIP-2612 (permit), scritto a mano perche' il
/// mock non dipende da OpenZeppelin: serve a esercitare payWithPermit del
/// contratto di inoltro, che altrimenti resterebbe non testato in locale.
/// Solo per test; nessuna pretesa di equivalenza con il contratto reale.
contract MockEURe {
    string public constant name = "Mock EURe";
    string public constant symbol = "EURe";
    string private constant VERSION = "1";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Nonce di permit per indirizzo: incrementale, impedisce che una firma
    /// gia' consumata venga riproposta.
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // Il separatore di dominio si mette in cache alla costruzione, come fa
    // OpenZeppelin: evita di ricalcolarlo a ogni permit. Si ricalcola solo se
    // il chain id cambia rispetto a quello del deploy (fork della catena).
    bytes32 private immutable CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable CACHED_CHAIN_ID;

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);

        CACHED_CHAIN_ID = block.chainid;
        CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "saldo insufficiente");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "saldo insufficiente");
        require(allowance[from][msg.sender] >= value, "allowance insufficiente");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    /// EIP-2612: autorizza `spender` a spendere `value` per conto di `owner`
    /// tramite una firma fuori catena, invece della classica `approve`.
    ///
    /// Il nonce usato e' quello corrente di `owner` e sale di uno solo se la
    /// firma e' valida: una firma scaduta o non riconducibile a `owner` fa
    /// fallire la chiamata senza toccare ne' il nonce ne' l'allowance, cosi'
    /// il chiamante (il contratto di inoltro, che tiene il permit in
    /// try/catch) puo' ignorare l'errore e proseguire.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "permit scaduto");

        uint256 nonceCorrente = nonces[owner];
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonceCorrente, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

        // ecrecover restituisce l'indirizzo zero su input malformati invece
        // di revertire: il confronto con `owner` copre entrambi i casi, firma
        // corrotta e firma di qualcun altro.
        address firmatario = ecrecover(digest, v, r, s);
        require(firmatario != address(0) && firmatario == owner, "firma non valida");

        nonces[owner] = nonceCorrente + 1;
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == CACHED_CHAIN_ID ? CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(VERSION)), block.chainid, address(this))
        );
    }

    /// ERC-5267: espone i parametri del dominio EIP-712 cosi' come sono
    /// davvero, invece di lasciare che chi firma li indovini o li hardcodi.
    /// `fields = 0x0f` dichiara presenti name, version, chainId e
    /// verifyingContract, assenti salt ed estensioni.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory nomeDominio,
            string memory versione,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", name, VERSION, block.chainid, address(this), bytes32(0), new uint256[](0));
    }
}
