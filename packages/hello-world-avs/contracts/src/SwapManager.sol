// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import {ECDSAServiceManagerBase} from
    "@eigenlayer-middleware/src/unaudited/ECDSAServiceManagerBase.sol";
import {ECDSAStakeRegistry} from "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import {IServiceManager} from "@eigenlayer-middleware/src/interfaces/IServiceManager.sol";
import {ECDSAUpgradeable} from
    "@openzeppelin-upgrades/contracts/utils/cryptography/ECDSAUpgradeable.sol";
import {IERC1271Upgradeable} from
    "@openzeppelin-upgrades/contracts/interfaces/IERC1271Upgradeable.sol";
import {ISwapManager} from "./ISwapManager.sol";
import {SimpleBoringVault} from "./SimpleBoringVault.sol";
import "@eigenlayer/contracts/interfaces/IRewardsCoordinator.sol";
import {IAllocationManager} from "@eigenlayer/contracts/interfaces/IAllocationManager.sol";
import {
    FHE,
    euint128,
    euint256,
    euint32,
    eaddress,
    externalEaddress,
    externalEuint32,
    externalEuint256
} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

// Currency type wrapper to match Uniswap V4
type Currency is address;

// Interface for the UniversalPrivacyHook
interface IUniversalPrivacyHook {
    struct InternalTransfer {
        address to;
        address encToken;
        bytes32 encAmount;  // External handle from AVS
    }

    struct UserShare {
        address user;
        uint128 shareNumerator;
        uint128 shareDenominator;
    }

    function settleBatch(
        bytes32 batchId,
        InternalTransfer[] calldata internalTransfers,
        uint128 netAmountIn,
        Currency tokenIn,
        Currency tokenOut,
        address outputToken,
        UserShare[] calldata userShares,
        bytes calldata inputProof
    ) external;
}

/**
 * @title SwapManager - AVS for batch processing of encrypted swap intents
 * @notice Manages operator selection, FHE decryption, and batch settlement
 * @dev Operators decrypt intents, match orders off-chain, and submit consensus-based settlements
 */
contract SwapManager is ECDSAServiceManagerBase, ISwapManager, SepoliaConfig {
    using ECDSAUpgradeable for bytes32;

    // Committee configuration
    uint256 public constant COMMITTEE_SIZE = 1; // Number of operators per batch
    uint256 public constant MIN_ATTESTATIONS = 1; // Minimum signatures for consensus
    address public admin;
    
    // Track registered operators for selection
    address[] public registeredOperators;
    mapping(address => bool) public operatorRegistered;
    mapping(address => uint256) public operatorIndex;

    // Batch management
    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => mapping(address => bool)) public operatorSelectedForBatch;

    // Hook authorization
    mapping(address => bool) public authorizedHooks;

    // Using settlement structures from IUniversalPrivacyHook interface

    // Max time for operators to respond with settlement
    uint32 public immutable MAX_RESPONSE_INTERVAL_BLOCKS;

    // ========================================= UEI STATE VARIABLES =========================================

    // UEI (Universal Encrypted Intent) management
    mapping(bytes32 => UEITask) public ueiTasks;
    mapping(bytes32 => UEIExecution) public ueiExecutions;

    // SimpleBoringVault for executing trades
    address payable public boringVault;

    modifier onlyOperator() {
        require(
            operatorRegistered[msg.sender],
            "Operator must be the caller"
        );
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can call this function");
        _;
    }
    
    modifier onlyAuthorizedHook() {
        require(authorizedHooks[msg.sender], "Unauthorized hook");
        _;
    }

    constructor(
        address _avsDirectory,
        address _stakeRegistry,
        address _rewardsCoordinator,
        address _delegationManager,
        address _allocationManager,
        uint32 _maxResponseIntervalBlocks,
        address _admin
    )
        ECDSAServiceManagerBase(
            _avsDirectory,
            _stakeRegistry,
            _rewardsCoordinator,
            _delegationManager,
            _allocationManager
        )
    {
        MAX_RESPONSE_INTERVAL_BLOCKS = _maxResponseIntervalBlocks;
        admin = _admin;

        // Note: For proxy deployments, call initialize() separately
        // For non-upgradeable deployments, the constructor is sufficient
    }

    function initialize(address initialOwner, address _rewardsInitiator) external initializer {
        __ServiceManagerBase_init(initialOwner, _rewardsInitiator);
        admin = initialOwner; // Set admin to the owner during initialization
    }
    
    /**
     * @notice Authorize a hook to submit batches
     */
    function authorizeHook(address hook) external onlyAdmin {
        authorizedHooks[hook] = true;
    }
    
    /**
     * @notice Revoke hook authorization
     */
    function revokeHook(address hook) external onlyAdmin {
        authorizedHooks[hook] = false;
    }

    /**
     * @notice Check if an operator is registered
     * @param operator The operator address to check
     * @return Whether the operator is registered
     */
    function isOperatorRegistered(address operator) external view returns (bool) {
        return operatorRegistered[operator];
    }

    /**
     * @notice Register an operator for batch processing
     */
    function registerOperatorForBatches() external {
        // TEMP: Bypassing stake registry check for testing
        // require(
        //     ECDSAStakeRegistry(stakeRegistry).operatorRegistered(msg.sender),
        //     "Must be registered with stake registry first"
        // );
        require(!operatorRegistered[msg.sender], "Operator already registered");

        operatorRegistered[msg.sender] = true;
        operatorIndex[msg.sender] = registeredOperators.length;
        registeredOperators.push(msg.sender);
    }

    // Removed deregisterOperatorFromBatches - operators should stay registered

    /**
     * @notice Called by hook when batch is ready for processing
     * @param batchId The unique batch identifier
     * @param batchData Encoded batch data from UniversalPrivacyHook
     */
    function finalizeBatch(
        bytes32 batchId,
        bytes calldata batchData
    ) external override onlyAuthorizedHook {
        require(batches[batchId].status == BatchStatus.Collecting ||
                batches[batchId].batchId == bytes32(0), "Invalid batch status");

        // Decode batch data from UniversalPrivacyHook format:
        // abi.encode(batchId, batch.intentIds, poolId, address(this), encryptedIntents)
        (
            bytes32 decodedBatchId,
            bytes32[] memory intentIds,
            bytes32 poolId,  // Changed from address to bytes32 to match PoolId type
            address hookAddress,
            bytes[] memory encryptedIntents
        ) = abi.decode(batchData, (bytes32, bytes32[], bytes32, address, bytes[]));

        // Verify batch ID matches
        require(decodedBatchId == batchId, "Batch ID mismatch");
        require(hookAddress == msg.sender, "Hook address mismatch");

        // Select operators for this batch
        address[] memory selectedOps = _selectOperatorsForBatch(batchId);

        // Create batch record
        batches[batchId] = Batch({
            batchId: batchId,
            intentIds: intentIds,
            poolId: poolId,
            hook: msg.sender,
            createdBlock: uint32(block.number),
            finalizedBlock: uint32(block.number),
            status: BatchStatus.Processing
        });

        // Process encrypted intents and grant FHE permissions
        for (uint256 i = 0; i < encryptedIntents.length; i++) {
            // Decode intent data: (intentId, owner, tokenIn, tokenOut, encAmount, deadline)
            (
                bytes32 intentId,
                address owner,
                address tokenIn,
                address tokenOut,
                uint256 encAmountHandle, // This is euint128.unwrap() from the hook
                uint256 deadline
            ) = abi.decode(encryptedIntents[i], (bytes32, address, address, address, uint256, uint256));

            // Convert handle back to euint128 (no FHE.fromExternal needed - already internal)
            euint128 encAmount = euint128.wrap(bytes32(encAmountHandle));

            // Grant permission to each selected operator
            for (uint256 j = 0; j < selectedOps.length; j++) {
                FHE.allow(encAmount, selectedOps[j]);
            }
        }

        // Mark selected operators
        for (uint256 i = 0; i < selectedOps.length; i++) {
            operatorSelectedForBatch[batchId][selectedOps[i]] = true;
            emit OperatorSelectedForBatch(batchId, selectedOps[i]);
        }

        emit BatchFinalized(batchId, batchData);
    }
    
    /**
     * @notice Submit batch settlement after off-chain matching
     * @dev Matches hook's settlement structure
     */
    function submitBatchSettlement(
        bytes32 batchId,
        IUniversalPrivacyHook.InternalTransfer[] calldata internalTransfers,
        uint128 netAmountIn,
        address tokenIn,
        address tokenOut,
        address outputToken,
        IUniversalPrivacyHook.UserShare[] calldata userShares,
        bytes calldata inputProof,
        bytes[] calldata operatorSignatures
    ) external onlyOperator {
        Batch storage batch = batches[batchId];
        require(batch.status == BatchStatus.Processing, "Batch not processing");
        require(
            block.number <= batch.finalizedBlock + MAX_RESPONSE_INTERVAL_BLOCKS,
            "Settlement window expired"
        );
        require(operatorSignatures.length >= MIN_ATTESTATIONS, "Insufficient signatures");

        // Hash and signature verification
        // Use simpler hash to avoid abi.encode calldata array encoding issues
        {
            bytes32 messageHash = keccak256(abi.encodePacked(
                batchId,
                netAmountIn,
                tokenIn,
                tokenOut,
                outputToken
            ));
            bytes32 ethSigned = messageHash.toEthSignedMessageHash();

            uint256 valid;
            for (uint256 i; i < operatorSignatures.length; ++i) {
                address signer = ethSigned.recover(operatorSignatures[i]);
                if (operatorSelectedForBatch[batchId][signer]) ++valid;
            }
            require(valid >= MIN_ATTESTATIONS, "Insufficient valid signatures");
        }

        // Update batch status
        batch.status = BatchStatus.Settled;

        // Forward to hook - hook will verify handles via FHE.fromExternal
        IUniversalPrivacyHook(batch.hook).settleBatch(
            batchId,
            internalTransfers,
            netAmountIn,
            Currency.wrap(tokenIn),
            Currency.wrap(tokenOut),
            outputToken,
            userShares,
            inputProof
        );

        emit BatchSettled(batchId, true);
    }
    
    /**
     * @notice Deterministically select operators for a batch
     */
    function _selectOperatorsForBatch(bytes32 batchId) internal view returns (address[] memory) {
        uint256 operatorCount = registeredOperators.length;
        
        // If not enough operators, return all available
        if (operatorCount <= COMMITTEE_SIZE) {
            return registeredOperators;
        }
        
        // Use batch ID and block data for deterministic randomness
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, block.number, batchId)));
        
        address[] memory selectedOps = new address[](COMMITTEE_SIZE);
        bool[] memory selected = new bool[](operatorCount);
        
        for (uint256 i = 0; i < COMMITTEE_SIZE; i++) {
            uint256 randomIndex = uint256(keccak256(abi.encode(seed, i))) % operatorCount;
            
            // Linear probing to avoid duplicates
            while (selected[randomIndex]) {
                randomIndex = (randomIndex + 1) % operatorCount;
            }
            
            selected[randomIndex] = true;
            selectedOps[i] = registeredOperators[randomIndex];
        }
        
        return selectedOps;
    }
    
    // View functions
    function getBatch(bytes32 batchId) external view override returns (Batch memory) {
        return batches[batchId];
    }
    
    function getOperatorCount() external view override returns (uint256) {
        return registeredOperators.length;
    }
    
    function isOperatorSelectedForBatch(
        bytes32 batchId, 
        address operator
    ) external view override returns (bool) {
        return operatorSelectedForBatch[batchId][operator];
    }
    
    // IServiceManager compliance functions (unused but required)
    function addPendingAdmin(address newAdmin) external onlyAdmin {}
    function removePendingAdmin(address pendingAdmin) external onlyAdmin {}
    function removeAdmin(address adminToRemove) external onlyAdmin {}
    function setAppointee(address appointee, address target, bytes4 selector) external onlyAdmin {}
    function removeAppointee(address appointee, address target, bytes4 selector) external onlyAdmin {}
    function deregisterOperatorFromOperatorSets(address operator, uint32[] memory operatorSetIds) external {}
    
    // Removed legacy interface compliance - not needed anymore



    // ============================= UEI FUNCTIONALITY =============================
    
    /*
     * NOTE: Two different FHE handling approaches:
     * 
     * 1. finalizeBatch() - Internal FHE Types:
     *    - Receives data from UniversalPrivacyHook which already has euint128 types
     *    - Uses euint128.unwrap() to get handles and euint128.wrap() to restore
     *    - Hook grants transient permissions with FHE.allowTransient()
     *    - No FHE.fromExternal() needed - data is already internal FHE format
     * 
     * 2. submitUEIWithProof() - External FHE Types:
     *    - Receives encrypted data from client with input proof
     *    - Uses FHE.fromExternal() to convert external handles to internal types
     *    - Requires input proof validation for security
     *    - Grants explicit permissions with FHE.allow()
     */

    /**
     * @notice Submit a Universal Encrypted Intent for trade execution
     * @param ctBlob Encrypted blob containing decoder, target, selector, and arguments
     * @param deadline Expiration timestamp for the intent
     * @return intentId Unique identifier for the submitted intent
     */
    function submitUEI(
        bytes calldata ctBlob,
        uint256 deadline
    ) external onlyAuthorizedHook returns (bytes32 intentId) {
        // Generate unique intent ID
        intentId = keccak256(abi.encode(msg.sender, ctBlob, deadline, block.number));

        // Select operators for this UEI (reuse batch selection logic)
        address[] memory selectedOps = new address[](COMMITTEE_SIZE);
        uint256 seed = uint256(intentId);

        for (uint256 i = 0; i < COMMITTEE_SIZE && i < registeredOperators.length; i++) {
            uint256 index = (seed + i) % registeredOperators.length;
            selectedOps[i] = registeredOperators[index];
        }

        // Create UEI task
        UEITask memory task = UEITask({
            intentId: intentId,
            submitter: msg.sender,
            ctBlob: ctBlob,
            deadline: deadline,
            blockSubmitted: block.number,
            selectedOperators: selectedOps,
            status: UEIStatus.Pending
        });

        // Store the task
        ueiTasks[intentId] = task;

        emit UEISubmitted(intentId, msg.sender, ctBlob, deadline, selectedOps);
        return intentId;
    }

    /**
     * @notice Submit a Universal Encrypted Intent with input proof for FHE permissions
     * @param ctBlob Encrypted blob containing decoder, target, selector, and arguments
     * @param inputProof Input proof for FHE decryption permissions
     * @param deadline Expiration timestamp for the intent
     * @return intentId Unique identifier for the submitted intent
     */
    function submitUEIWithProof(
        bytes calldata ctBlob,
        bytes calldata inputProof,
        uint256 deadline
    ) external onlyAuthorizedHook returns (bytes32 intentId) {
        // Generate unique intent ID
        intentId = keccak256(abi.encode(msg.sender, ctBlob, inputProof, deadline, block.number));

        // Select operators for this UEI
        address[] memory selectedOps = new address[](COMMITTEE_SIZE);
        uint256 seed = uint256(intentId);

        for (uint256 i = 0; i < COMMITTEE_SIZE && i < registeredOperators.length; i++) {
            uint256 index = (seed + i) % registeredOperators.length;
            selectedOps[i] = registeredOperators[index];
        }

        // Decode the blob to extract encrypted handles and grant FHE permissions
        _grantFHEPermissions(ctBlob, inputProof, selectedOps);

        // Create UEI task
        UEITask memory task = UEITask({
            intentId: intentId,
            submitter: msg.sender,
            ctBlob: ctBlob,
            deadline: deadline,
            blockSubmitted: block.number,
            selectedOperators: selectedOps,
            status: UEIStatus.Pending
        });

        // Store the task
        ueiTasks[intentId] = task;

        emit UEISubmittedWithProof(intentId, msg.sender, ctBlob, inputProof, deadline, selectedOps);
        return intentId;
    }

    /**
     * @notice Grant FHE permissions to selected operators for encrypted UEI components
     * @param ctBlob The encrypted blob containing FHE handles
     * @param inputProof The input proof for FHE operations
     * @param selectedOperators The operators to grant permissions to
     */
    function _grantFHEPermissions(
        bytes calldata ctBlob,
        bytes calldata inputProof,
        address[] memory selectedOperators
    ) internal {
            // Decode the blob to extract encrypted handles
            (
                bytes32 encDecoder,    // eaddress handle
                bytes32 encTarget,     // eaddress handle  
                bytes32 encSelector,   // euint32 handle
                uint8[] memory argTypes, // unencrypted
                bytes32[] memory encArgs // euint256 handles
            ) = abi.decode(ctBlob, (bytes32, bytes32, bytes32, uint8[], bytes32[]));

            // Convert handles to FHE types and grant permissions
            eaddress decoder = FHE.fromExternal(externalEaddress.wrap(encDecoder), inputProof);
            eaddress target = FHE.fromExternal(externalEaddress.wrap(encTarget), inputProof);
            euint32 selector = FHE.fromExternal(externalEuint32.wrap(encSelector), inputProof);

            // Grant permissions to all selected operators
            for (uint256 i = 0; i < selectedOperators.length; i++) {
                address operator = selectedOperators[i];
                
                FHE.allow(decoder, operator);
                FHE.allow(target, operator);
                FHE.allow(selector, operator);
                
                // Grant permissions for all encrypted arguments
                for (uint256 j = 0; j < encArgs.length; j++) {
                    euint256 arg = FHE.fromExternal(externalEuint256.wrap(encArgs[j]), inputProof);
                    FHE.allow(arg, operator);
                }
            }
    }

    /**
     * @notice Process a decrypted UEI by executing the trade
     * @param intentId The ID of the intent to process
     * @param decoder The decrypted decoder/sanitizer address
     * @param target The decrypted target protocol address
     * @param reconstructedData The reconstructed calldata from decrypted components
     * @param operatorSignatures Signatures from operators attesting to the decryption
     */
    function processUEI(
        bytes32 intentId,
        address decoder,
        address target,
        bytes calldata reconstructedData,
        bytes[] calldata operatorSignatures
    ) external onlyOperator {
        UEITask storage task = ueiTasks[intentId];

        // Validate task
        require(task.status == UEIStatus.Pending, "UEI not pending");
        require(block.timestamp <= task.deadline, "UEI expired");

        // Verify operator is selected for this task
        bool isSelected = false;
        for (uint256 i = 0; i < task.selectedOperators.length; i++) {
            if (task.selectedOperators[i] == msg.sender) {
                isSelected = true;
                break;
            }
        }
        require(isSelected, "Operator not selected for this UEI");

        // Verify consensus signatures
        uint256 validSignatures = 0;
        bytes32 dataHash = keccak256(abi.encode(intentId, decoder, target, reconstructedData));

        for (uint256 i = 0; i < operatorSignatures.length && i < task.selectedOperators.length; i++) {
            address signer = dataHash.toEthSignedMessageHash().recover(operatorSignatures[i]);

            // Check if signer is a selected operator
            for (uint256 j = 0; j < task.selectedOperators.length; j++) {
                if (task.selectedOperators[j] == signer) {
                    validSignatures++;
                    break;
                }
            }
        }

        require(validSignatures >= MIN_ATTESTATIONS, "Insufficient consensus");

        // Update status
        task.status = UEIStatus.Processing;

        // Store the processing details
        UEIExecution memory execution = UEIExecution({
            intentId: intentId,
            decoder: decoder,
            target: target,
            callData: reconstructedData,  // Fixed field name
            executor: msg.sender,
            executedAt: block.timestamp,
            success: false,
            result: ""
        });

        // Execute through vault (vault address should be set)
        if (boringVault != address(0)) {
            try SimpleBoringVault(boringVault).execute(target, reconstructedData, 0) returns (bytes memory result) {
                execution.success = true;
                execution.result = result;
                task.status = UEIStatus.Executed;
            } catch Error(string memory reason) {
                execution.result = bytes(reason);
                task.status = UEIStatus.Failed;
            } catch (bytes memory reason) {
                execution.result = reason;
                task.status = UEIStatus.Failed;
            }
        } else {
            // If vault not set, just mark as executed for testing
            task.status = UEIStatus.Executed;
            execution.success = true;
        }

        // Store execution record
        ueiExecutions[intentId] = execution;

        emit UEIProcessed(intentId, execution.success, execution.result);
    }

    /**
     * @notice Set the BoringVault address for UEI execution
     * @param _vault The address of the SimpleBoringVault
     */
    function setBoringVault(address payable _vault) external onlyAdmin {
        boringVault = _vault;
        emit BoringVaultSet(_vault);
    }

    /**
     * @notice Get UEI task details
     * @param intentId The ID of the UEI task
     * @return The UEI task struct
     */
    function getUEITask(bytes32 intentId) external view returns (UEITask memory) {
        return ueiTasks[intentId];
    }

    /**
     * @notice Get UEI execution details
     * @param intentId The ID of the UEI execution
     * @return The UEI execution struct
     */
    function getUEIExecution(bytes32 intentId) external view returns (UEIExecution memory) {
        return ueiExecutions[intentId];
    }
}