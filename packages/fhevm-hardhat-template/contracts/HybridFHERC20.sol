// SPDX-License-Identifier: MIT

pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {FHE, externalEuint128, euint128} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @dev Minimal implementation of an FHERC20 token
 * Implementation of the bare minimum methods to make
 * the hook work with a hybrid FHE / ERC20 token
 */
contract HybridFHERC20 is ERC20, IFHERC20, SepoliaConfig {

    //errors
    error HybridFHERC20__InvalidSender();
    error HybridFHERC20__InvalidReceiver();


    //encrypted balances
    mapping(address => euint128) public encBalances;
    euint128 public totalEncryptedSupply = FHE.asEuint128(0);

    //zero constant
    euint128 private immutable ZERO = FHE.asEuint128(0);

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        FHE.allowThis(ZERO);
    }

    // ----------- Public Mint Functions --------------------
    function mint(address user, uint256 amount) public {
        _mint(user, amount);
    }

    // ----------- Public Burn Functions --------------------
    function burn(address user, uint256 amount) public {
        _burn(user, amount);
    }

    // ----------- Encrypted Mint Functions -----------------
    function mintEncrypted(address user, externalEuint128 amount, bytes calldata inputProof) public {
        _mintEnc(user, FHE.fromExternal(amount, inputProof));
    }
    
    function mintEncrypted(address user, euint128 amount) public {
        _mintEnc(user, amount);
    }

    function _mintEnc(address user, euint128 amount) internal {
        encBalances[user] = FHE.add(encBalances[user], amount);
        totalEncryptedSupply = FHE.add(totalEncryptedSupply, amount);

        FHE.allowThis(encBalances[user]);
        FHE.allow(encBalances[user], user);
        FHE.allowThis(totalEncryptedSupply);
        
        // Emit standard Transfer event with encrypted handle as value
        // This makes transfers visible on Etherscan while preserving privacy
        emit Transfer(address(0), user, uint256(euint128.unwrap(amount)));
    }

    // ----------- Encrypted Burn Functions -----------------
    function burnEncrypted(address user, externalEuint128 amount, bytes calldata inputProof) public {
        _burnEnc(user, FHE.fromExternal(amount, inputProof));
    }
    
    function burnEncrypted(address user, euint128 amount) public {
        _burnEnc(user, amount);
    }

    function _burnEnc(address user, euint128 amount) internal {
        euint128 burnAmount = _calculateBurnAmount(user, amount);
        encBalances[user] = FHE.sub(encBalances[user], burnAmount);
        totalEncryptedSupply = FHE.sub(totalEncryptedSupply, burnAmount);

        FHE.allowThis(encBalances[user]);
        FHE.allow(encBalances[user], user);
        FHE.allowThis(totalEncryptedSupply);
        
        // Emit standard Transfer event with encrypted handle as value
        emit Transfer(user, address(0), uint256(euint128.unwrap(burnAmount)));
    }

    function _calculateBurnAmount(address user, euint128 amount) internal returns(euint128){
        return FHE.select(FHE.le(amount, encBalances[user]), amount, ZERO);
    }

    // ----------- Encrypted Transfer Functions ---------------
    function transferEncrypted(address to, externalEuint128 amount, bytes calldata inputProof) external returns(euint128) {
        return _transferImpl(msg.sender, to, FHE.fromExternal(amount, inputProof));
    }

    function transferEncrypted(address to, euint128 amount) external returns(euint128) {
        return _transferImpl(msg.sender, to, amount);
    }

    function transferFromEncrypted(address from, address to, externalEuint128 amount, bytes calldata inputProof) external returns(euint128) {
        return _transferImpl(from, to, FHE.fromExternal(amount, inputProof));
    }

    function transferFromEncrypted(address from, address to, euint128 amount) external returns(euint128) {
        return _transferImpl(from, to, amount);
    }

    function _transferImpl(address from, address to, euint128 amount) internal returns (euint128) {
        //ensure sender / receiver is not 0x00
        if(from == address(0)){
            revert HybridFHERC20__InvalidSender();
        }
        if(to == address(0)){
            revert HybridFHERC20__InvalidReceiver();
        }

        // Make sure the sender has enough tokens.
        euint128 amountToSend = FHE.select(FHE.le(amount, encBalances[from]), amount, ZERO);

        // Add to the balance of `to` and subract from the balance of `from`.
        encBalances[to] = FHE.add(encBalances[to], amountToSend);
        encBalances[from] = FHE.sub(encBalances[from], amountToSend);

        //allow contract to interact with balances
        FHE.allowThis(encBalances[to]);
        FHE.allowThis(encBalances[from]);

        //allow users to interact with their balances
        FHE.allow(encBalances[to], to);
        FHE.allow(encBalances[from], from);
        
        // Emit standard Transfer event with encrypted handle as value
        emit Transfer(from, to, uint256(euint128.unwrap(amountToSend)));

        return amountToSend;
    }

    // --------- Decrypt Balance Functions ------------------
    mapping(uint256 => address) private _decryptRequests;
    
    function requestBalanceDecryption(address user) public returns(uint256) {
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = euint128.unwrap(encBalances[user]);
        uint256 requestId = FHE.requestDecryption(cts, this.finalizeBalanceDecryption.selector);
        _decryptRequests[requestId] = user;
        return requestId;
    }

    function finalizeBalanceDecryption(uint256 requestId, bytes memory cleartexts, bytes memory decryptionProof) public {
        // Verify the decryption proof and signatures
        FHE.checkSignatures(requestId, cleartexts, decryptionProof);

        // Decode the decrypted value(s)
        (uint128 decryptedBalance) = abi.decode(cleartexts, (uint128));

        address user = _decryptRequests[requestId];
        require(user != address(0), "Invalid request ID");

        // Handle decryptedBalance as needed
        delete _decryptRequests[requestId];
    }

    // --------- Encrypted Wrapping Functions ---------------
    function wrap(address user, uint128 amount) external {
        _wrap(user, amount);
    }

    function _wrap(address user, uint128 amount) internal {
        //burn public balance
        _burn(user, uint256(amount));

        //mint encrypted balance
        _mintEnc(user, FHE.asEuint128(amount));
    }

    // --------- Encrypted Unwrapping Functions ---------------
    function requestUnwrap(address user, externalEuint128 amount, bytes calldata inputProof) external returns(euint128) {
        return _requestUnwrap(user, FHE.fromExternal(amount, inputProof));
    }

    function requestUnwrap(address user, euint128 amount) external returns(euint128) {
        return _requestUnwrap(user, amount);
    }

    // Removed old getUnwrapResult functions as we now use async callbacks

    mapping(uint256 => UnwrapRequest) private _unwrapRequests;
    struct UnwrapRequest {
        address user;
        euint128 burnAmount;
    }
    
    function _requestUnwrap(address user, euint128 amount) internal returns(euint128 burnAmount) {
        burnAmount = _calculateBurnAmount(user, amount);
        
        // Request decryption of burn amount
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = euint128.unwrap(burnAmount);
        uint256 requestId = FHE.requestDecryption(cts, this.finalizeUnwrap.selector);
        
        _unwrapRequests[requestId] = UnwrapRequest({
            user: user,
            burnAmount: burnAmount
        });
        
        FHE.allowThis(burnAmount);
        FHE.allow(burnAmount, msg.sender);
    }

    function finalizeUnwrap(uint256 requestId, bytes memory cleartexts, bytes memory decryptionProof) public {
        // Verify the decryption proof and signatures
        FHE.checkSignatures(requestId, cleartexts, decryptionProof);

        // Decode the decrypted value(s)
        (uint128 amount) = abi.decode(cleartexts, (uint128));

        UnwrapRequest memory request = _unwrapRequests[requestId];
        require(request.user != address(0), "Invalid request ID");

        // Burn encrypted balance
        _burnEnc(request.user, request.burnAmount);

        // Mint public balance
        _mint(request.user, amount);
        
        // Clean up
        delete _unwrapRequests[requestId];
    }

    // Legacy unwrap functions removed - now using async callbacks
}
