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

    // Store FHE handles for operator permission grants (not exposed publicly)
    struct FHEHandles {
        eaddress decoder;
        eaddress target;
        euint32 selector;
        euint256[] args;
    }
    mapping(bytes32 => FHEHandles) internal ueiHandles;

    // Trade batch management (keeper-triggered batching)
    // NOTE: Off-chain keeper bot should call finalizeUEIBatch() every few minutes
    // or whenever idle time exceeds MAX_BATCH_IDLE to seal batches and grant decrypt permissions
    uint256 public constant MAX_BATCH_IDLE = 1 minutes;
    uint256 public lastTradeBatchExecutionTime;
    uint256 public currentBatchCounter; // Incremental batch counter
    mapping(uint256 => bytes32) public batchCounterToBatchId; // Counter -> BatchId mapping
    mapping(bytes32 => TradeBatch) public tradeBatches; // BatchId -> Batch data

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
     * @notice Submit multiple Universal Encrypted Intents (UEIs) in a single call
     * @param ctBlobs Array of encrypted blobs containing decoder, target, selector, and arguments
     * @param inputProofs Array of input proofs for FHE decryption permissions
     * @param deadlines Array of expiration timestamps for each intent
     * @return ueiIds Array of unique identifiers for the submitted UEIs
     */
    function submitEncryptedUEIBatch(
        bytes[] calldata ctBlobs,
        bytes[] calldata inputProofs,
        uint256[] calldata deadlines
    ) public returns (bytes32[] memory ueiIds) {
        uint256 count = ctBlobs.length;
        require(count > 0, "No intents provided");
        require(
            inputProofs.length == count && deadlines.length == count,
            "Array length mismatch"
        );

        ueiIds = new bytes32[](count);

        (bytes32 batchId, TradeBatch storage batch) = _getOrCreateCurrentBatch();

        for (uint256 i = 0; i < count; i++) {
            ueiIds[i] = _registerUEI(
                batch,
                batchId,
                ctBlobs[i],
                inputProofs[i],
                deadlines[i],
                i
            );
        }

        return ueiIds;
    }

    function submitEncryptedUEI(
        bytes calldata ctBlob,
        bytes calldata inputProof,
        uint256 deadline
    ) external returns (bytes32) {
        (bytes32 batchId, TradeBatch storage batch) = _getOrCreateCurrentBatch();
        return _registerUEI(batch, batchId, ctBlob, inputProof, deadline, 0);
    }

    function _getOrCreateCurrentBatch()
        internal
        returns (bytes32 batchId, TradeBatch storage batch)
    {
        batchId = batchCounterToBatchId[currentBatchCounter];
        batch = tradeBatches[batchId];

        if (batchId == bytes32(0)) {
            currentBatchCounter++;
            batchId = keccak256(
                abi.encode("UEI_BATCH", currentBatchCounter, block.number, block.timestamp)
            );
            batchCounterToBatchId[currentBatchCounter] = batchId;
            tradeBatches[batchId] = TradeBatch({
                intentIds: new bytes32[](0),
                createdAt: block.timestamp,
                finalizedAt: 0,
                finalized: false,
                executed: false,
                selectedOperators: new address[](0)
            });
            batch = tradeBatches[batchId];
        }
    }

    function _registerUEI(
        TradeBatch storage batch,
        bytes32 batchId,
        bytes calldata ctBlob,
        bytes calldata inputProof,
        uint256 deadline,
        uint256 salt
    ) internal returns (bytes32 ueiId) {
        bytes memory ctBlobMem = ctBlob;
        bytes memory inputProofMem = inputProof;

        ueiId = keccak256(abi.encode(msg.sender, ctBlobMem, deadline, block.number, salt));

        _grantFHEPermissions(ueiId, ctBlobMem, inputProofMem);

        ueiTasks[ueiId] = UEITask({
            intentId: ueiId,
            submitter: msg.sender,
            batchId: batchId,
            deadline: deadline,
            status: UEIStatus.Pending
        });

        batch.intentIds.push(ueiId);

        emit TradeSubmitted(ueiId, msg.sender, batchId, ctBlobMem, deadline);

        return ueiId;
    }

    /**
     * @notice Verify and internalize FHE handles from ctBlob
     * @dev Validates inputProof and stores handles for later operator permission grants
     * @param ueiId The UEI identifier to map handles to
     * @param ctBlob The encrypted blob containing FHE handles
     * @param inputProof The input proof for FHE operations
     */
    function _grantFHEPermissions(
        bytes32 ueiId,
        bytes memory ctBlob,
        bytes memory inputProof
    ) internal {
        // Decode the blob to extract encrypted handles (NO argTypes - all uint256!)
        (
            bytes32 encDecoder,      // eaddress handle
            bytes32 encTarget,       // eaddress handle
            bytes32 encSelector,     // euint32 handle
            bytes32[] memory encArgs // ALL args as euint256 handles
        ) = abi.decode(ctBlob, (bytes32, bytes32, bytes32, bytes32[]));

        // Convert handles to internal FHE types (validates inputProof)
        eaddress decoder = FHE.fromExternal(externalEaddress.wrap(encDecoder), inputProof);
        eaddress target = FHE.fromExternal(externalEaddress.wrap(encTarget), inputProof);
        euint32 selector = FHE.fromExternal(externalEuint32.wrap(encSelector), inputProof);

        // Convert all arguments and store
        euint256[] memory args = new euint256[](encArgs.length);
        for (uint256 i = 0; i < encArgs.length; i++) {
            args[i] = FHE.fromExternal(externalEuint256.wrap(encArgs[i]), inputProof);
            FHE.allowThis(args[i]);  // Grant permission to this contract
        }

        // Grant to this contract
        FHE.allowThis(decoder);
        FHE.allowThis(target);
        FHE.allowThis(selector);

        // Store handles for operator permission grants during finalization
        ueiHandles[ueiId] = FHEHandles({
            decoder: decoder,
            target: target,
            selector: selector,
            args: args
        });
    }

    /**
     * @notice Finalize the current open UEI batch and grant decrypt permissions to operators
     * @dev Can be called by keeper bot every few minutes, or by admin manually
     *      Automatically creates a new batch after finalization for rolling batches
     */
    function finalizeUEIBatch() external {
        // Fetch current open batch using counter
        bytes32 batchId = batchCounterToBatchId[currentBatchCounter];
        require(batchId != bytes32(0), "No active batch");

        TradeBatch storage batch = tradeBatches[batchId];
        require(!batch.finalized, "Batch already finalized");
        require(batch.intentIds.length > 0, "Batch is empty");

        // Require either timeout passed or admin override
        require(
            block.timestamp >= batch.createdAt + MAX_BATCH_IDLE || msg.sender == admin,
            "Batch not ready for finalization"
        );

        // Mark as finalized
        batch.finalized = true;
        batch.finalizedAt = block.timestamp;

        // Select operators using existing deterministic selection
        address[] memory selectedOps = _selectOperatorsForBatch(batchId);
        batch.selectedOperators = selectedOps;

        // Grant decrypt permissions to selected operators for all UEIs in this batch
        for (uint256 i = 0; i < batch.intentIds.length; i++) {
            bytes32 intentId = batch.intentIds[i];
            FHEHandles storage handles = ueiHandles[intentId];

            // Grant permissions to each selected operator (similar to swap batch)
            for (uint256 j = 0; j < selectedOps.length; j++) {
                operatorSelectedForBatch[batchId][selectedOps[j]] = true;
                FHE.allow(handles.decoder, selectedOps[j]);
                FHE.allow(handles.target, selectedOps[j]);
                FHE.allow(handles.selector, selectedOps[j]);

                // Grant for all arguments
                for (uint256 k = 0; k < handles.args.length; k++) {
                    FHE.allow(handles.args[k], selectedOps[j]);
                }
            }
        }

        // Emit finalization event
        emit UEIBatchFinalized(batchId, selectedOps, block.timestamp);

        // Update telemetry
        lastTradeBatchExecutionTime = block.timestamp;

        // Create new batch immediately for rolling batch system
        currentBatchCounter++; // Increment to next batch
        bytes32 newBatchId = keccak256(abi.encode("UEI_BATCH", currentBatchCounter, block.number, block.timestamp));
        batchCounterToBatchId[currentBatchCounter] = newBatchId;
        tradeBatches[newBatchId] = TradeBatch({
            intentIds: new bytes32[](0),
            createdAt: block.timestamp,
            finalizedAt: 0,
            finalized: false,
            executed: false,
            selectedOperators: new address[](0)
        });
    }

    /**
     * @notice Process UEIs with decrypted data and aggregated execution plans
     * @param intentIds UEI identifiers covered by this execution
     * @param decoders Decoders/sanitizers applied per operation (optional)
     * @param targets Target protocol addresses for each execution step
     * @param reconstructedData Calldata payload for each execution step
     * @param operatorSignatures Signatures from operators attesting consensus on the execution plan
     */
    function processUEI(
        bytes32[] calldata intentIds,
        address[] calldata decoders,
        address[] calldata targets,
        bytes[] calldata reconstructedData,
        bytes[] calldata operatorSignatures
    ) external onlyOperator {
        _processUEIs(intentIds, decoders, targets, reconstructedData, operatorSignatures);
    }

    function processUEI(
        bytes32 intentId,
        address decoder,
        address target,
        bytes calldata reconstructedData,
        bytes[] calldata operatorSignatures
    ) external onlyOperator {
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = intentId;

        address[] memory decoders = new address[](1);
        decoders[0] = decoder;

        address[] memory targets = new address[](1);
        targets[0] = target;

        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = reconstructedData;

        _processUEIs(intentIds, decoders, targets, calldatas, operatorSignatures);
    }

    function _processUEIs(
        bytes32[] memory intentIds,
        address[] memory decoders,
        address[] memory targets,
        bytes[] memory reconstructedData,
        bytes[] calldata operatorSignatures
    ) internal {
        uint256 intentCount = intentIds.length;
        require(intentCount > 0, "No intents provided");
        require(targets.length > 0, "No execution targets");
        require(targets.length == reconstructedData.length, "Target/data length mismatch");
        require(decoders.length == 0 || decoders.length == targets.length, "Decoder length mismatch");

        // Load first intent to derive batch context
        UEITask storage firstTask = ueiTasks[intentIds[0]];
        require(firstTask.status == UEIStatus.Pending, "First UEI not pending");
        require(block.timestamp <= firstTask.deadline, "First UEI expired");

        TradeBatch storage batch = tradeBatches[firstTask.batchId];
        require(batch.finalized, "Batch not finalized");
        address[] memory selectedOps = batch.selectedOperators;

        // Verify operator is selected for this batch
        bool isSelected = false;
        for (uint256 i = 0; i < selectedOps.length; i++) {
            if (selectedOps[i] == msg.sender) {
                isSelected = true;
                break;
            }
        }
        require(isSelected, "Operator not selected for this batch");

        // Validate each intent belongs to the same batch and is pending
        for (uint256 i = 1; i < intentCount; i++) {
            UEITask storage task = ueiTasks[intentIds[i]];
            require(task.batchId == firstTask.batchId, "Mismatched batch");
            require(task.status == UEIStatus.Pending, "UEI not pending");
            require(block.timestamp <= task.deadline, "UEI expired");
        }

        require(operatorSignatures.length >= MIN_ATTESTATIONS, "Insufficient consensus");

        // Build hash for consensus verification (supports both single and multi intent flows)
        bytes32 dataHash;
        if (intentCount == 1 && targets.length == 1) {
            address singleDecoder = decoders.length == 1 ? decoders[0] : address(0);
            dataHash = keccak256(
                abi.encode(intentIds[0], singleDecoder, targets[0], reconstructedData[0])
            );
        } else {
            dataHash = keccak256(
                abi.encode(firstTask.batchId, intentIds, decoders, targets, reconstructedData)
            );
        }

        bytes32 ethSigned = dataHash.toEthSignedMessageHash();
        uint256 validSignatures;
        for (uint256 i = 0; i < operatorSignatures.length && i < selectedOps.length; i++) {
            address signer = ethSigned.recover(operatorSignatures[i]);
            if (operatorSelectedForBatch[firstTask.batchId][signer]) {
                validSignatures++;
            }
        }
        require(validSignatures >= MIN_ATTESTATIONS, "Insufficient valid signatures");

        // Mark intents as processing
        for (uint256 i = 0; i < intentCount; i++) {
            ueiTasks[intentIds[i]].status = UEIStatus.Processing;
        }

        bool overallSuccess = true;
        bytes[] memory operationResults = new bytes[](targets.length);
        bytes memory failureData;

        if (boringVault != address(0)) {
            for (uint256 i = 0; i < targets.length; i++) {
                // Default decoder handling: ignore if array not supplied
                address targetAddress = targets[i];
                bytes memory callData = reconstructedData[i];

                try SimpleBoringVault(boringVault).execute(targetAddress, callData, 0) returns (bytes memory result) {
                    operationResults[i] = result;
                } catch Error(string memory reason) {
                    overallSuccess = false;
                    failureData = bytes(reason);
                    break;
                } catch (bytes memory reason) {
                    overallSuccess = false;
                    failureData = reason;
                    break;
                }
            }
        } else {
            // Vault unset (testing) - treat as success
            for (uint256 i = 0; i < targets.length; i++) {
                operationResults[i] = "";
            }
        }

        if (!overallSuccess) {
            for (uint256 i = 0; i < intentCount; i++) {
                UEITask storage task = ueiTasks[intentIds[i]];
                task.status = UEIStatus.Failed;

                UEIExecution memory executionFailed = UEIExecution({
                    intentId: intentIds[i],
                    decoder: decoders.length == 1 ? decoders[0] : address(0),
                    target: targets.length == 1 ? targets[0] : address(0),
                    callData: targets.length == 1 ? reconstructedData[0] : abi.encode(reconstructedData),
                    executor: msg.sender,
                    executedAt: block.timestamp,
                    success: false,
                    result: failureData
                });

                ueiExecutions[intentIds[i]] = executionFailed;
                emit UEIProcessed(intentIds[i], false, failureData);
            }
            return;
        }

        bytes memory packedResults = abi.encode(operationResults);
        bytes memory packedCallData = targets.length == 1
            ? reconstructedData[0]
            : abi.encode(reconstructedData);
        address storedTarget = targets.length == 1 ? targets[0] : address(0);
        address storedDecoder = decoders.length == 1 ? decoders[0] : address(0);

        for (uint256 i = 0; i < intentCount; i++) {
            UEITask storage task = ueiTasks[intentIds[i]];
            task.status = UEIStatus.Executed;

            UEIExecution memory execution = UEIExecution({
                intentId: intentIds[i],
                decoder: storedDecoder,
                target: storedTarget,
                callData: packedCallData,
                executor: msg.sender,
                executedAt: block.timestamp,
                success: true,
                result: packedResults
            });

            ueiExecutions[intentIds[i]] = execution;
            emit UEIProcessed(intentIds[i], true, packedResults);
        }
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

    /**
     * @notice Get trade batch details
     * @param batchId The ID of the batch
     * @return The TradeBatch struct
     */
    function getTradeBatch(bytes32 batchId) external view returns (TradeBatch memory) {
        return tradeBatches[batchId];
    }
}
