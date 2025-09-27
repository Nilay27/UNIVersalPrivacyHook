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
import {ISwapManager} from "./interfaces/ISwapManager.sol";

// Token & Security
import {IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

// FHE - Zama FHEVM
import {FHE, externalEuint128, euint128} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract UniversalPrivacyHook is BaseHook, IUnlockCallback, ReentrancyGuardTransient, SepoliaConfig {

    // =============================================================
    //                           EVENTS
    // =============================================================
    
    event EncryptedTokenCreated(PoolId indexed poolId, Currency indexed currency, address token);
    event Deposited(PoolId indexed poolId, Currency indexed currency, address indexed user, uint256 amount, address encryptedToken);
    event IntentSubmitted(PoolId indexed poolId, Currency tokenIn, Currency tokenOut, address indexed user, bytes32 intentId);
    event Withdrawn(PoolId indexed poolId, Currency indexed currency, address indexed user, address recipient, uint256 amount);

    // AVS Batch Events
    event BatchCreated(bytes32 indexed batchId, PoolId indexed poolId, uint256 intentCount);
    event BatchFinalized(bytes32 indexed batchId, uint256 intentCount);
    event BatchSettled(bytes32 indexed batchId);
    event BatchExecuted(bytes32 indexed batchId, uint128 netAmountIn, uint128 netAmountOut);

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
        PoolKey poolKey;         // Pool key for the swap
        bytes32 batchId;         // Batch this intent belongs to
    }

    /**
     * @dev Batch of intents for AVS processing
     */
    struct Batch {
        bytes32[] intentIds;     // Intent IDs in this batch
        uint256 createdBlock;    // Block when batch was created
        uint256 submittedBlock;  // Block when batch was submitted to AVS
        bool finalized;          // Whether batch has been finalized
        bool settled;            // Whether batch has been settled
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

    /// @dev Global intent storage: intentId => Intent
    mapping(bytes32 => Intent) public intents;

    // AVS Batch Management
    /// @dev Batch interval in blocks (5 blocks = ~5-60 seconds depending on chain)
    uint256 public constant BATCH_INTERVAL = 5;

    /// @dev Current batch ID per pool
    mapping(PoolId => bytes32) public currentBatchId;

    /// @dev Batch storage
    mapping(bytes32 => Batch) public batches;

    /// @dev SwapManager address for AVS integration
    address public swapManager;

    // =============================================================
    //                        CONSTRUCTOR
    // =============================================================

    constructor(IPoolManager _poolManager) BaseHook(_poolManager) {
        // No FHE initialization needed in constructor
        // FHE operations will be done when actually needed
    }

    /**
     * @dev Set the SwapManager address (only once)
     * @param _swapManager Address of the AVS SwapManager contract
     */
    function setSwapManager(address _swapManager) external {
        require(swapManager == address(0), "SwapManager already set");
        require(_swapManager != address(0), "Invalid address");
        swapManager = _swapManager;
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
        require(address(key.hooks) == address(this), "Hook not enabled");

        // Validate currency belongs to this pool
        require(currency == key.currency0 || currency == key.currency1, "Invalid currency");
        
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

        emit Deposited(poolId, currency, msg.sender, amount, address(encryptedToken));
    }
    
    /**
     * @dev Submit an encrypted swap intent
     * TODO: Move intent submission logic to separate IntentManager contract
     * This will allow supporting multiple intent types (swapIntent, tradeIntent, limitIntent)
     * IntentManager will be the entry point but hook must always hold the funds
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
        require((tokenIn == key.currency0 && tokenOut == key.currency1) ||
                (tokenIn == key.currency1 && tokenOut == key.currency0), "Invalid pair");

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

        // Check and create/update batch
        bytes32 batchId = currentBatchId[poolId];
        Batch storage batch = batches[batchId];

        // Create new batch if needed (first batch or interval passed)
        if (batchId == bytes32(0) || block.number >= batch.createdBlock + BATCH_INTERVAL) {
            // Finalize the previous batch if it exists and has intents
            if (batchId != bytes32(0) && batch.intentIds.length > 0 && !batch.finalized) {
                _finalizeBatch(poolId, batchId);
            }

            // Create new batch
            batchId = keccak256(abi.encode(poolId, block.number, block.timestamp));
            currentBatchId[poolId] = batchId;
            batches[batchId] = Batch({
                intentIds: new bytes32[](0),
                createdBlock: block.number,
                submittedBlock: 0,
                finalized: false,
                settled: false
            });
            batch = batches[batchId];
        }

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
            batchId: batchId
        });

        // Add intent to current batch
        batch.intentIds.push(intentId);

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
        // For privacy, we could block external swaps or allow them
        // For now, let's allow external swaps but process intents first
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
    
    // =============================================================
    //                      HELPER FUNCTIONS
    // =============================================================
    
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
    
    function _getCurrencySymbol(Currency currency) internal view returns (string memory) {
        // Try to get the symbol from the ERC20 token
        try IERC20Metadata(Currency.unwrap(currency)).symbol() returns (string memory symbol) {
            return symbol;
        } catch {
            // Fallback if token doesn't implement symbol()
            return "TOKEN";
        }
    }
    
    // =============================================================
    //                    BATCH MANAGEMENT
    // =============================================================

    /**
     * @dev Finalize a batch and submit to AVS for processing (external callable)
     * @param poolId The pool ID to finalize batch for
     */
    function finalizeBatch(PoolId poolId) external {
        bytes32 batchId = currentBatchId[poolId];
        require(batchId != bytes32(0), "No active batch");

        Batch storage batch = batches[batchId];
        require(!batch.finalized, "Already finalized");
        require(block.number >= batch.createdBlock + BATCH_INTERVAL, "Batch not ready");
        require(batch.intentIds.length > 0, "Empty batch");

        _finalizeBatch(poolId, batchId);
    }

    /**
     * @dev Internal function to finalize a batch
     * @param poolId The pool ID
     * @param batchId The batch ID to finalize
     */
    function _finalizeBatch(PoolId poolId, bytes32 batchId) internal {
        Batch storage batch = batches[batchId];

        // Mark as finalized
        batch.finalized = true;
        batch.submittedBlock = block.number;

        // Package batch data for AVS
        bytes[] memory encryptedIntents = new bytes[](batch.intentIds.length);

        for (uint i = 0; i < batch.intentIds.length; i++) {
            Intent storage intent = intents[batch.intentIds[i]];

            // Package intent data for AVS
            encryptedIntents[i] = abi.encode(
                batch.intentIds[i],
                intent.owner,
                intent.tokenIn,
                intent.tokenOut,
                euint128.unwrap(intent.encAmount), // Pass the encrypted handle
                intent.deadline
            );
        }

        // Submit to AVS SwapManager
        if (swapManager != address(0)) {
            bytes memory batchData = abi.encode(
                batchId,
                batch.intentIds,
                poolId,
                address(this),
                encryptedIntents
            );

            ISwapManager(swapManager).finalizeBatch(batchId, batchData);
        }

        // Start new batch for the pool
        currentBatchId[poolId] = bytes32(0);

        emit BatchCreated(batchId, poolId, batch.intentIds.length);
        emit BatchFinalized(batchId, batch.intentIds.length);
    }

    // Settlement structures for AVS
    struct InternalTransfer {
        address to;             // User receiving tokens
        address encToken;       // IFHERC20 token address (e.g., eUSDC or eUSDT contract)
        euint128 encAmount;     // Already encrypted amount from AVS
    }

    struct UserShare {
        address user;           // User address
        uint128 shareNumerator; // User's share numerator (e.g., 4 for 4/5)
        uint128 shareDenominator; // Share denominator (e.g., 5 for 4/5)
    }

    // State variable to track AMM output for distribution
    uint128 private lastSwapOutput;

    /**
     * @dev Settle a batch with internal transfers and net swaps from AVS
     * @param batchId The batch ID to settle
     * @param internalTransfers Internal transfers to users (only minting since hook holds tokens)
     * @param netAmountIn Total amount to swap in AMM (unencrypted)
     * @param tokenIn Input currency for AMM swap (pool token)
     * @param tokenOut Output currency for AMM swap (pool token)
     * @param outputToken IFHERC20 token address for output distribution
     * @param userShares How to distribute AMM output among users (as ratios)
     */
    function settleBatch(
        bytes32 batchId,
        InternalTransfer[] calldata internalTransfers,
        uint128 netAmountIn,
        Currency tokenIn,
        Currency tokenOut,
        address outputToken,
        UserShare[] calldata userShares
    ) external {
        // TODO: Add onlySwapManager modifier once SwapManager interface is added
        require(swapManager != address(0), "SwapManager not set");
        require(msg.sender == swapManager, "Only SwapManager");

        Batch storage batch = batches[batchId];
        require(batch.finalized, "Batch not finalized");
        require(!batch.settled, "Already settled");

        // Get pool key from first intent
        Intent storage firstIntent = intents[batch.intentIds[0]];
        PoolKey memory key = firstIntent.poolKey;

        // Process internal transfers (hook already holds all tokens from intents)
        for (uint i = 0; i < internalTransfers.length; i++) {
            InternalTransfer memory transfer = internalTransfers[i];

            // Cast to IFHERC20 interface
            IFHERC20 encToken = IFHERC20(transfer.encToken);

            // AVS provides encrypted amounts, just grant permissions
            FHE.allowThis(transfer.encAmount);
            FHE.allow(transfer.encAmount, address(encToken));

            // Mint to receiver (hook already holds sender's tokens from submitIntent)
            encToken.mintEncrypted(transfer.to, transfer.encAmount);
        }

        // Execute net swap on AMM if needed
        if (netAmountIn > 0) {
            // Reset last swap output
            lastSwapOutput = 0;

            // Use unlock callback to execute the net swap
            bytes memory unlockData = abi.encode(
                key,
                batchId,
                netAmountIn,
                tokenIn,
                tokenOut,
                address(this)
            );

            poolManager.unlock(unlockData);

            // Now lastSwapOutput contains the actual amount received from AMM
            require(lastSwapOutput > 0, "Swap failed");

            // Distribute AMM output based on user shares
            IFHERC20 encOutputToken = IFHERC20(outputToken);

            for (uint i = 0; i < userShares.length; i++) {
                UserShare memory share = userShares[i];

                // Calculate user's portion: (lastSwapOutput * numerator) / denominator
                uint128 userAmount = (lastSwapOutput * share.shareNumerator) / share.shareDenominator;

                // Create encrypted amount and mint to user
                euint128 encAmount = FHE.asEuint128(userAmount);
                FHE.allowThis(encAmount);
                FHE.allow(encAmount, address(encOutputToken));

                encOutputToken.mintEncrypted(share.user, encAmount);
            }
        }

        // Mark batch as settled
        batch.settled = true;

        // Mark all intents as processed
        for (uint i = 0; i < batch.intentIds.length; i++) {
            intents[batch.intentIds[i]].processed = true;
        }

        emit BatchSettled(batchId);
    }

    // =============================================================
    //                      UNLOCK CALLBACK
    // =============================================================
    
    function unlockCallback(bytes calldata data) external override onlyPoolManager returns (bytes memory) {
        // Decode the batch settlement data (batchId instead of intentId for AVS settlement)
        (PoolKey memory key, bytes32 batchId, uint128 amount, Currency tokenIn, Currency tokenOut, address owner) =
            abi.decode(data, (PoolKey, bytes32, uint128, Currency, Currency, address));

        PoolId poolId = key.toId();
        
        // Determine swap direction
        bool zeroForOne = tokenIn == key.currency0;
        
        // Execute swap with EXACT INPUT (negative amount in V4)
        SwapParams memory swapParams = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(uint256(amount)),  // Negative for exact input in V4
            sqrtPriceLimitX96: zeroForOne ? 
                TickMath.MIN_SQRT_PRICE + 1 : 
                TickMath.MAX_SQRT_PRICE - 1
        });
        
        BalanceDelta delta = poolManager.swap(key, swapParams, ZERO_BYTES);
        
        // Read signed deltas
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        
        // Settle what we owe (negative), take what we're owed (positive)
        if (d0 < 0) {
            key.currency0.settle(poolManager, address(this), uint128(-d0), false);
        }
        if (d1 < 0) {
            key.currency1.settle(poolManager, address(this), uint128(-d1), false);
        }
        if (d0 > 0) {
            key.currency0.take(poolManager, address(this), uint128(d0), false);
        }
        if (d1 > 0) {
            key.currency1.take(poolManager, address(this), uint128(d1), false);
        }
        
        // Calculate output amount from the positive delta of the output currency
        uint128 outputAmount;
        if (tokenOut == key.currency0) {
            require(d0 > 0, "No token0 output");
            outputAmount = uint128(d0);
        } else {
            require(d1 > 0, "No token1 output");
            outputAmount = uint128(d1);
        }
        
        // Update hook reserves for batch net swap
        poolReserves[poolId][tokenIn] -= amount;
        poolReserves[poolId][tokenOut] += outputAmount;

        // Store the output amount for distribution in settleBatch
        lastSwapOutput = outputAmount;

        emit BatchExecuted(batchId, amount, outputAmount);

        return ZERO_BYTES;
    }
}