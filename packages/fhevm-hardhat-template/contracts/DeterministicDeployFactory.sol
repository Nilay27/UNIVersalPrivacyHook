// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract DeterministicDeployFactory {
    event Deploy(address addr);

    function deploy(bytes memory bytecode, uint256 _salt) external payable returns (address) {
        address addr;
        assembly {
            addr := create2(callvalue(), add(bytecode, 0x20), mload(bytecode), _salt)
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        emit Deploy(addr);
        return addr;
    }
    
    // Helper function to compute CREATE2 address
    function computeAddress(bytes memory bytecode, uint256 _salt) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(_salt),
                keccak256(bytecode)
            )
        );
        return address(uint160(uint256(hash)));
    }
}