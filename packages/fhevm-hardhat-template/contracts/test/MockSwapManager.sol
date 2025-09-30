// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapManager} from "../interfaces/ISwapManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

// Interface for calling settleBatch on hook
interface IHookSettlement {
    struct InternalTransfer {
        address to;
        address encToken;
        bytes32 encAmount;
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
        address tokenIn,
        address tokenOut,
        address outputToken,
        UserShare[] calldata userShares,
        bytes calldata inputProof
    ) external;
}

/**
 * @title MockSwapManager
 * @dev Mock implementation of ISwapManager for testing
 * @notice This mock allows testing batch finalization and settlement without deploying the full AVS
 */
contract MockSwapManager is ISwapManager {
    address public hook;

    // Store finalized batches
    mapping(bytes32 => bool) public finalizedBatches;

    event BatchFinalized(bytes32 indexed batchId);
    event BatchSettled(bytes32 indexed batchId);

    constructor() {}

    /**
     * @dev Set the hook address for testing
     */
    function setHook(address _hook) external {
        hook = _hook;
    }

    /**
     * @inheritdoc ISwapManager
     */
    function createBatch(
        bytes32 batchId,
        address,
        PoolId,
        bytes[] calldata,
        address[] calldata
    ) external override {
        // Mock implementation - just mark as created
        finalizedBatches[batchId] = false;
    }

    /**
     * @inheritdoc ISwapManager
     */
    function selectOperatorsForBatch(bytes32) external pure override returns (address[] memory) {
        // Mock implementation - return empty array
        address[] memory operators = new address[](0);
        return operators;
    }

    /**
     * @inheritdoc ISwapManager
     */
    function finalizeBatch(bytes32 batchId, bytes calldata batchData) external override {
        // Mark batch as finalized
        finalizedBatches[batchId] = true;
        emit BatchFinalized(batchId);
    }

    /**
     * @dev Mock function to call settleBatch on the hook
     * @notice In production, this would be called by operators after decrypting and matching intents
     */
    function mockSettleBatch(
        bytes32 batchId,
        IHookSettlement.InternalTransfer[] calldata internalTransfers,
        uint128 netAmountIn,
        address tokenIn,
        address tokenOut,
        address outputToken,
        IHookSettlement.UserShare[] calldata userShares,
        bytes calldata inputProof
    ) external {
        require(hook != address(0), "Hook not set");
        require(finalizedBatches[batchId], "Batch not finalized");

        // Call settleBatch on the hook
        IHookSettlement(hook).settleBatch(
            batchId,
            internalTransfers,
            netAmountIn,
            tokenIn,
            tokenOut,
            outputToken,
            userShares,
            inputProof
        );

        emit BatchSettled(batchId);
    }
}
