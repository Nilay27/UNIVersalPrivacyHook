// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniversalPrivacyHook} from "../UniversalPrivacyHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";

/**
 * @title TestableUniversalPrivacyHook
 * @dev Test version that bypasses hook address validation
 */
contract TestableUniversalPrivacyHook is UniversalPrivacyHook {
    constructor(IPoolManager _poolManager) UniversalPrivacyHook(_poolManager) {}

    /**
     * @dev Override to bypass address validation in tests
     */
    function validateHookAddress(BaseHook _this) internal pure override {
        // Skip validation in test environment
    }
}