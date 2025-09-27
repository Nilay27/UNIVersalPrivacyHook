// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/**
 * @title ISwapManager
 * @dev Interface for AVS SwapManager that handles batch processing
 */
interface ISwapManager {
    /**
     * @dev Submit a batch of encrypted intents for processing
     * @param batchId Unique identifier for the batch
     * @param hook Address of the hook contract
     * @param poolId Pool identifier
     * @param encryptedIntents Array of encrypted intent data
     * @param selectedOperators Operators selected for this batch
     */
    function createBatch(
        bytes32 batchId,
        address hook,
        PoolId poolId,
        bytes[] calldata encryptedIntents,
        address[] calldata selectedOperators
    ) external;

    /**
     * @dev Select operators for processing a batch
     * @param batchId Batch identifier
     * @return Selected operator addresses
     */
    function selectOperatorsForBatch(bytes32 batchId) external returns (address[] memory);

    /**
     * @dev Finalize a batch with processed data
     * @param batchId Batch identifier
     * @param batchData Processed batch data
     */
    function finalizeBatch(bytes32 batchId, bytes calldata batchData) external;
}