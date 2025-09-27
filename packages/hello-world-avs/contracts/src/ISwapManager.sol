// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

interface ISwapManager {
    // ============ BATCH SYSTEM ============
    
    // Batch structures (removed - not used with hook's settlement structure)
    
    struct Batch {
        bytes32 batchId;
        bytes32[] intentIds;
        address poolId;
        address hook;
        uint32 createdBlock;
        uint32 finalizedBlock;
        BatchStatus status;
    }
    
    enum BatchStatus {
        Collecting,
        Processing,
        Settled,
        Failed
    }

    // Batch events
    event BatchFinalized(bytes32 indexed batchId, bytes batchData);
    event BatchSettlementSubmitted(bytes32 indexed batchId, uint256 internalizedCount, uint256 netSwapCount);
    event BatchSettled(bytes32 indexed batchId, bool success);
    event OperatorSelectedForBatch(bytes32 indexed batchId, address indexed operator);

    // Batch functions
    function finalizeBatch(
        bytes32 batchId,
        bytes calldata batchData
    ) external;
    
    // Batch view functions
    function getBatch(bytes32 batchId) external view returns (Batch memory);
    function getOperatorCount() external view returns (uint256);
    function isOperatorSelectedForBatch(bytes32 batchId, address operator) external view returns (bool);
    function isOperatorRegistered(address operator) external view returns (bool);
    function registerOperatorForBatches() external;

    // Batch events
    event BatchFinalized(bytes32 indexed batchId, bytes batchData);
    event BatchSettled(bytes32 indexed batchId, bool success);
    event OperatorSelectedForBatch(bytes32 indexed batchId, address indexed operator);

    // ============ UEI (Universal Encrypted Intent) SYSTEM ============

    // UEI status tracking
    enum UEIStatus {
        Pending,
        Processing,
        Executed,
        Failed,
        Expired
    }

    // UEI task structure
    struct UEITask {
        bytes32 intentId;
        address submitter;
        bytes ctBlob;  // Contains encrypted decoder, target, selector, args
        uint256 deadline;
        uint256 blockSubmitted;
        address[] selectedOperators;
        UEIStatus status;
    }

    // UEI execution record
    struct UEIExecution {
        bytes32 intentId;
        address decoder;
        address target;
        bytes callData;  // Renamed from calldata (reserved keyword)
        address executor;
        uint256 executedAt;
        bool success;
        bytes result;
    }

    // UEI events
    event UEISubmitted(
        bytes32 indexed intentId,
        address indexed submitter,
        bytes ctBlob,
        uint256 deadline,
        address[] selectedOperators
    );

    event UEIProcessed(
        bytes32 indexed intentId,
        bool success,
        bytes result
    );

    event BoringVaultSet(address indexed vault);

    // UEI functions
    function submitUEI(
        bytes calldata ctBlob,
        uint256 deadline
    ) external returns (bytes32 intentId);

    function processUEI(
        bytes32 intentId,
        address decoder,
        address target,
        bytes calldata reconstructedData,
        bytes[] calldata operatorSignatures
    ) external;

    function setBoringVault(address payable _vault) external;

    // UEI view functions
    function getUEITask(bytes32 intentId) external view returns (UEITask memory);
    function getUEIExecution(bytes32 intentId) external view returns (UEIExecution memory);
}