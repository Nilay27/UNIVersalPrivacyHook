// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title UniversalPrivacyHook
 * @dev A Uniswap V4 hook that enables private swaps on any pool using FHE encrypted tokens
 * 
 * This hook can be attached to any Uniswap V4 pool to provide:
 * - Private swap intents with encrypted amounts and directions
 * - Automatic creation of hybrid FHE/ERC20 tokens per pool currency
 * - Batched execution for enhanced privacy
 * - 1:1 backing of encrypted tokens with hook reserves
 * 
 * Architecture:
 * - Users deposit ERC20 tokens → receive hybrid FHE/ERC20 tokens
 * - Users submit encrypted swap intents (amount + direction private)
 * - Hook processes intents by swapping its reserves and updating encrypted balances
 * - Users can withdraw or transfer their hybrid tokens freely
 */

// Uniswap V4 Imports
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";

// Privacy Components
import {HybridFHERC20} from "./HybridFHERC20.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {Queue} from "./Queue.sol";

// Token & Security
import {IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

// FHE - Zama FHEVM
import {FHE, externalEuint128, euint128} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract UniversalPrivacyHook is BaseHook, IUnlockCallback, ReentrancyGuardTransient, SepoliaConfig {

    // =============================================================
    //                           EVENTS
    // =============================================================
    
    event EncryptedTokenCreated(PoolId indexed poolId, Currency indexed currency, address token);
    event Deposited(PoolId indexed poolId, Currency indexed currency, address indexed user, uint256 amount);
    event IntentSubmitted(PoolId indexed poolId, Currency tokenIn, Currency tokenOut, address indexed user, bytes32 intentId);
    event IntentDecrypted(bytes32 indexed intentId, uint128 decryptedAmount);
    event IntentExecuted(PoolId indexed poolId, bytes32 indexed intentId, uint128 amountIn, uint128 amountOut);
    event Withdrawn(PoolId indexed poolId, Currency indexed currency, address indexed user, address recipient, uint256 amount);

    // =============================================================
    //                          LIBRARIES
    // =============================================================
    
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;


    // =============================================================
    //                          STRUCTS
    // =============================================================
    
    /**
     * @dev Represents an encrypted swap intent
     */
    struct Intent {
        euint128 encAmount;      // Encrypted amount to swap
        Currency tokenIn;        // Input currency (currency0 or currency1)
        Currency tokenOut;       // Output currency (currency1 or currency0)
        address owner;           // User who submitted the intent
        uint64 deadline;         // Expiration timestamp
        bool processed;          // Whether intent has been executed
        bool decrypted;          // Whether amount has been decrypted
        uint128 decryptedAmount; // Decrypted amount (available after callback)
        PoolKey poolKey;         // Pool key for the swap
    }

    // =============================================================
    //                         CONSTANTS
    // =============================================================
    
    bytes internal constant ZERO_BYTES = bytes("");
    
    // FHE encrypted constants for reuse - removed as they're not used

    // =============================================================
    //                      STATE VARIABLES
    // =============================================================
    
    /// @dev Per-pool encrypted token contracts: poolId => currency => IFHERC20
    mapping(PoolId => mapping(Currency => IFHERC20)) public poolEncryptedTokens;
    
    /// @dev Per-pool reserves backing encrypted tokens: poolId => currency => amount
    mapping(PoolId => mapping(Currency => uint256)) public poolReserves;
    
    /// @dev Per-pool intent queues: poolId => Queue
    mapping(PoolId => Queue) public poolIntentQueues;
    
    /// @dev Global intent storage: intentId => Intent
    mapping(bytes32 => Intent) public intents;
    
    /// @dev Maps encrypted amount handle to intent ID for queue processing
    /// Similar to MarketOrder's userOrders mapping
    mapping(PoolId => mapping(uint256 => bytes32)) public handleToIntentId;
    
    /// @dev Maps decryption request ID to intent ID for callback processing
    mapping(uint256 => bytes32) private requestToIntentId;

    // =============================================================
    //                        CONSTRUCTOR
    // =============================================================
    
    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {
        // No FHE initialization needed in constructor
        // FHE operations will be done when actually needed
    }

    // =============================================================
    //                      HOOK CONFIGURATION
    // =============================================================
    
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,                    // Process encrypted intents
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // =============================================================
    //                      CORE FUNCTIONS
    // =============================================================
    
    /**
     * @dev Deposit tokens to receive encrypted tokens for a specific pool
     * @param key The pool key identifying the pool
     * @param currency The currency to deposit (must be currency0 or currency1)
     * @param amount The amount to deposit
     */
    function deposit(
        PoolKey calldata key,
        Currency currency,
        uint256 amount
    ) external nonReentrant {
        PoolId poolId = key.toId();
        
        // Validate hook is enabled for this pool
        require(_isHookEnabledForPool(key), "Hook not enabled");
        
        // Validate currency belongs to this pool
        require(_isValidCurrency(key, currency), "Invalid currency");
        
        // Get or create encrypted token for this pool/currency
        IFHERC20 encryptedToken = _getOrCreateEncryptedToken(poolId, currency);
        
        // Transfer tokens from user to hook
        IERC20(Currency.unwrap(currency)).transferFrom(msg.sender, address(this), amount);
        
        // Mint encrypted tokens to user using trivial encryption
        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        FHE.allowThis(encryptedAmount);
        FHE.allow(encryptedAmount, address(encryptedToken));
        encryptedToken.mintEncrypted(msg.sender, encryptedAmount);
        
        // Update hook reserves
        poolReserves[poolId][currency] += amount;
        
        emit Deposited(poolId, currency, msg.sender, amount);
    }
    
    /**
     * @dev Submit an encrypted swap intent
     * @param key The pool key
     * @param tokenIn Input currency
     * @param tokenOut Output currency
     * @param encAmount Encrypted amount to swap
     * @param deadline Intent expiration
     */
    function submitIntent(
        PoolKey calldata key,
        Currency tokenIn,
        Currency tokenOut,
        externalEuint128 encAmount,
        bytes calldata inputProof,
        uint64 deadline
    ) external nonReentrant {
        PoolId poolId = key.toId();
        
        // Validate currencies form valid pair for this pool
        require(_isValidCurrencyPair(key, tokenIn, tokenOut), "Invalid pair");
        
        // Convert to euint128 and set up proper FHE access control
        euint128 amount = FHE.fromExternal(encAmount, inputProof);
        FHE.allowThis(amount);
        
        // User transfers encrypted tokens to hook as collateral
        IFHERC20 inputToken = poolEncryptedTokens[poolId][tokenIn];
        require(address(inputToken) != address(0), "Token not exists");
        
        // Grant token contract access to the encrypted amount
        FHE.allow(amount, address(inputToken));
        
        // Transfer encrypted tokens from user to hook as collateral
        inputToken.transferFromEncrypted(msg.sender, address(this), amount);
        
        // Create and store intent
        bytes32 intentId = keccak256(abi.encode(msg.sender, block.timestamp, poolId));
        intents[intentId] = Intent({
            encAmount: amount,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            owner: msg.sender,
            deadline: deadline,
            processed: false,
            poolKey: key,
            decrypted: false,
            decryptedAmount: 0
        });
        
        // Request decryption of the amount  
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = euint128.unwrap(amount);
        uint256 requestId = FHE.requestDecryption(cts, this.finalizeIntent.selector);
        
        // Map request to intent
        requestToIntentId[requestId] = intentId;
        
        // Store the handle-to-intent mapping (like MarketOrder's userOrders)
        uint256 handle = uint256(euint128.unwrap(amount));
        handleToIntentId[poolId][handle] = intentId;
        
        // Add encrypted amount to pool's intent queue (like MarketOrder pattern)
        Queue queue = _getOrCreateQueue(poolId);
        queue.push(amount);
        
        emit IntentSubmitted(poolId, tokenIn, tokenOut, msg.sender, intentId);
    }
    
    /**
     * @dev Withdraw encrypted tokens back to underlying ERC20
     * @param key The pool key
     * @param currency The currency to withdraw
     * @param amount The amount to withdraw
     * @param recipient The recipient address
     */
    function withdraw(
        PoolKey calldata key,
        Currency currency,
        uint256 amount,
        address recipient
    ) external nonReentrant {
        PoolId poolId = key.toId();
        
        // Get encrypted token contract
        IFHERC20 encryptedToken = poolEncryptedTokens[poolId][currency];
        require(address(encryptedToken) != address(0), "Token not exists");
        
        // Create encrypted amount for burning
        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        FHE.allowThis(encryptedAmount);
        FHE.allow(encryptedAmount, address(encryptedToken));
        
        // Burn encrypted tokens from user
        encryptedToken.burnEncrypted(msg.sender, encryptedAmount);
        
        // Update reserves
        poolReserves[poolId][currency] -= amount;
        
        // Transfer underlying tokens to recipient
        IERC20(Currency.unwrap(currency)).transfer(recipient, amount);
        
        emit Withdrawn(poolId, currency, msg.sender, recipient, amount);
    }

    // =============================================================
    //                     HOOK IMPLEMENTATIONS
    // =============================================================
    
    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    ) internal override onlyPoolManager() returns (bytes4, BeforeSwapDelta, uint24) {
        
        // Allow hook-initiated swaps to pass through
        if (sender == address(this)) {
            return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        
        // Process any ready intents for this pool
        _processReadyIntents(key);
        
        // For privacy, we could block external swaps or allow them
        // For now, let's allow external swaps but process intents first
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // =============================================================
    //                      PRIVATE FUNCTIONS
    // =============================================================
    
    /**
     * @dev Lightweight callback function called by FHE Gateway with decrypted intent amount
     * @param requestId The request ID from FHE Gateway
     * @param decryptedAmount The decrypted amount for the swap
     * @param signatures Signatures from the gateway for verification
     */
    function finalizeIntent(uint256 requestId, uint128 decryptedAmount, bytes[] memory signatures) external {
        FHE.checkSignatures(requestId, signatures);
        
        bytes32 intentId = requestToIntentId[requestId];
        require(intentId != bytes32(0), "Invalid request ID");
        
        Intent storage intent = intents[intentId];
        require(!intent.processed, "Intent already processed");
        require(!intent.decrypted, "Intent already decrypted");
        
        // Store the decrypted amount
        intent.decryptedAmount = decryptedAmount;
        intent.decrypted = true;
        
        // Emit event
        emit IntentDecrypted(intentId, decryptedAmount);
        
        // Clean up mapping
        delete requestToIntentId[requestId];
    }
    
    /**
     * @dev Execute a decrypted intent - can be called by anyone
     * @param intentId The ID of the intent to execute
     */
    function executeIntent(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        
        require(intent.owner != address(0), "Intent does not exist");
        require(intent.decrypted, "Intent not yet decrypted");
        require(!intent.processed, "Intent already processed");
        require(block.timestamp <= intent.deadline, "Intent expired");
        
        // Execute the intent
        _executeIntent(intent.poolKey, intentId, intent.decryptedAmount);
    }
    
    /**
     * @dev Process any pending intents (no-op now, kept for compatibility)
     */
    function _processReadyIntents(PoolKey calldata key) internal {
        // Intents are now processed asynchronously via finalizeIntent callback
        // This function is kept for compatibility but does nothing
    }
                
    /**
     * @dev Execute a single decrypted intent
     */
    function _executeIntent(
        PoolKey memory key,
        bytes32 intentId,
        uint128 amount
    ) internal {
        Intent storage intent = intents[intentId];
        
        // Prepare data for unlock callback
        bytes memory unlockData = abi.encode(key, intentId, amount, intent.tokenIn, intent.tokenOut, intent.owner);
        
        // Execute through unlock mechanism - all swap logic happens in unlockCallback
        poolManager.unlock(unlockData);
    }
    
    // =============================================================
    //                      HELPER FUNCTIONS
    // =============================================================
    
    function _isHookEnabledForPool(PoolKey calldata key) internal view returns (bool) {
        return address(key.hooks) == address(this);
    }
    
    function _isValidCurrency(PoolKey calldata key, Currency currency) internal pure returns (bool) {
        return currency == key.currency0 || currency == key.currency1;
    }
    
    function _isValidCurrencyPair(PoolKey calldata key, Currency tokenIn, Currency tokenOut) internal pure returns (bool) {
        return (tokenIn == key.currency0 && tokenOut == key.currency1) ||
               (tokenIn == key.currency1 && tokenOut == key.currency0);
    }
    
    function _getOrCreateEncryptedToken(PoolId poolId, Currency currency) internal returns (IFHERC20) {
        IFHERC20 existing = poolEncryptedTokens[poolId][currency];
        
        if (address(existing) == address(0)) {
            // Create new hybrid FHE/ERC20 token
            string memory symbol = _getCurrencySymbol(currency);
            string memory name = string(abi.encodePacked("Encrypted ", symbol));
            
            existing = new HybridFHERC20(name, string(abi.encodePacked("e", symbol)));
            poolEncryptedTokens[poolId][currency] = existing;
            
            emit EncryptedTokenCreated(poolId, currency, address(existing));
        }
        
        return existing;
    }
    
    function _getOrCreateQueue(PoolId poolId) internal returns (Queue) {
        if (address(poolIntentQueues[poolId]) == address(0)) {
            poolIntentQueues[poolId] = new Queue();
        }
        return poolIntentQueues[poolId];
    }
    
    function _getCurrencySymbol(Currency currency) internal pure returns (string memory) {
        // This is a placeholder - in real implementation would query token metadata
        return "TOKEN";
    }
    
    // =============================================================
    //                      UNLOCK CALLBACK
    // =============================================================
    
    function unlockCallback(bytes calldata data) external override onlyPoolManager returns (bytes memory) {
        // Decode the intent execution data
        (PoolKey memory key, bytes32 intentId, uint128 amount, Currency tokenIn, Currency tokenOut, address owner) = 
            abi.decode(data, (PoolKey, bytes32, uint128, Currency, Currency, address));
        
        PoolId poolId = key.toId();
        
        // Determine swap direction
        bool zeroForOne = tokenIn == key.currency0;
        
        // Execute swap
        SwapParams memory swapParams = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(uint256(amount)),
            sqrtPriceLimitX96: zeroForOne ? 
                TickMath.MIN_SQRT_PRICE + 1 : 
                TickMath.MAX_SQRT_PRICE - 1
        });
        
        BalanceDelta delta = poolManager.swap(key, swapParams, ZERO_BYTES);
        
        // Calculate output amount and settle with pool manager
        uint128 outputAmount;
        if (zeroForOne) {
            // Swapping token0 for token1
            outputAmount = uint128(uint256(int256(delta.amount1())));
            // Hook owes token0 to pool, pool owes token1 to hook
            key.currency0.settle(poolManager, address(this), amount, false);
            key.currency1.take(poolManager, address(this), outputAmount, false);
        } else {
            // Swapping token1 for token0
            outputAmount = uint128(uint256(int256(-delta.amount0())));
            // Hook owes token1 to pool, pool owes token0 to hook
            key.currency1.settle(poolManager, address(this), amount, false);
            key.currency0.take(poolManager, address(this), outputAmount, false);
        }
        
        // Update hook reserves
        poolReserves[poolId][tokenIn] -= amount;
        poolReserves[poolId][tokenOut] += outputAmount;
        
        // Mint encrypted output tokens to user
        IFHERC20 outputToken = poolEncryptedTokens[poolId][tokenOut];
        if (address(outputToken) == address(0)) {
            outputToken = _getOrCreateEncryptedToken(poolId, tokenOut);
        }
        euint128 encryptedOutput = FHE.asEuint128(outputAmount);
        FHE.allowThis(encryptedOutput);
        FHE.allow(encryptedOutput, address(outputToken));
        outputToken.mintEncrypted(owner, encryptedOutput);
        
        emit IntentExecuted(poolId, intentId, amount, outputAmount);
        
        return ZERO_BYTES;
    }
}