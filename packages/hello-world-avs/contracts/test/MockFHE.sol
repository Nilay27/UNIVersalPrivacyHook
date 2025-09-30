// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.12;

// Mock FHE types
type euint128 is bytes32;
type euint256 is bytes32;
type euint32 is bytes32;
type eaddress is bytes32;
type externalEaddress is bytes32;
type externalEuint32 is bytes32;
type externalEuint256 is bytes32;

/**
 * @title MockFHE
 * @dev Mock FHE library for testing - does nothing but prevents reverts
 */
library FHE {
    function allow(euint128, address) internal pure {
        // Mock: do nothing
    }

    function allow(euint256, address) internal pure {
        // Mock: do nothing
    }

    function allow(euint32, address) internal pure {
        // Mock: do nothing
    }

    function allow(eaddress, address) internal pure {
        // Mock: do nothing
    }

    function fromExternal(externalEaddress, bytes memory) internal pure returns (eaddress) {
        return eaddress.wrap(bytes32(0));
    }

    function fromExternal(externalEuint32, bytes memory) internal pure returns (euint32) {
        return euint32.wrap(bytes32(0));
    }

    function fromExternal(externalEuint256, bytes memory) internal pure returns (euint256) {
        return euint256.wrap(bytes32(0));
    }
}
