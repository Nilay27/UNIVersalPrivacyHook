// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

interface ISwapManager {
    // ============ BATCH SYSTEM ============
    
    // Batch structures (removed - not used with hook's settlement structure)
    
    struct Batch {
        bytes32 batchId;
        bytes32[] intentIds;
        bytes32 poolId;  // Changed from address to bytes32 to match PoolId type
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
    event BatchSettlementSubmitted(bytes32 indexed batchId, uint256 internalizedCount, uint256 netSwapCount);
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

    // ============ UEI (Universal Encrypted Intent) SYSTEM ============

    // UEI status tracking
    enum UEIStatus {
        Pending,
        Processing,
        Executed,
        Failed,
        Expired
    }

    // UEI task structure (minimal storage - ctBlob emitted in events only)
    struct UEITask {
        bytes32 intentId;
        address submitter;
        bytes32 batchId;         // Which batch this trade belongs to
        uint256 deadline;
        UEIStatus status;
    }

    // Trade batch structure for batching similar trades
    struct TradeBatch {
        bytes32[] intentIds;     // Trade IDs in this batch
        uint256 createdAt;       // Timestamp when batch created
        uint256 finalizedAt;     // Timestamp when finalized
        bool finalized;          // Whether finalized
        bool executed;           // Whether executed
        address[] selectedOperators; // Operators for this batch
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
    event TradeSubmitted(
        bytes32 indexed tradeId,
        address indexed submitter,
        bytes32 indexed batchId,
        bytes ctBlob,           // Operators decode this off-chain
        uint256 deadline
    );

    event UEIBatchFinalized(
        bytes32 indexed batchId,
        address[] selectedOperators,
        uint256 finalizedAt
    );

    event UEIProcessed(
        bytes32 indexed intentId,
        bool success,
        bytes result
    );

    event BoringVaultSet(address indexed vault);

    // UEI functions
    function submitEncryptedUEIBatch(
        bytes[] calldata ctBlobs,
        bytes[] calldata inputProofs,
        uint256[] calldata deadlines
    ) external returns (bytes32[] memory intentIds);

    function submitEncryptedUEI(
        bytes calldata ctBlob,
        bytes calldata inputProof,
        uint256 deadline
    ) external returns (bytes32 intentId);

    function processUEI(
        bytes32[] calldata intentIds,
        address[] calldata decoders,
        address[] calldata targets,
        bytes[] calldata reconstructedData,
        bytes[] calldata operatorSignatures
    ) external;

    function finalizeUEIBatch() external;

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
    function getTradeBatch(bytes32 batchId) external view returns (TradeBatch memory);
}
