// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/BaseSwapManager.sol";
import "../src/SimpleBoringVault.sol";

contract MockTarget {
    uint256 public lastValue;

    function setValue(uint256 value) external {
        lastValue = value;
    }
}

contract BaseSwapManagerTest is Test {
    BaseSwapManager private manager;
    SimpleBoringVault private vault;
    address private constant HOOK = address(0x123);
    address private constant CALLER = address(0x456);
    address private tradeManagerAddress;

    function setUp() public {
        tradeManagerAddress = address(this);
        vault = new SimpleBoringVault(HOOK, tradeManagerAddress);
        manager = new BaseSwapManager(
            address(this),
            payable(address(vault))
        );

        // Allow manager to execute through the vault
        vault.setExecutor(address(manager), true);

        // Authorize cross-chain caller
        manager.setCallerAuthorization(CALLER, true);
    }

    function testProcessUEIExecutesTargets() public {
        MockTarget target = new MockTarget();
        bytes memory callData = abi.encodeWithSelector(MockTarget.setValue.selector, 42);

        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = bytes32("intent-1");
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = callData;

        vm.prank(CALLER);
        manager.processUEI(intentIds, new address[](0), targets, calldatas, new bytes[](0));

        assertEq(target.lastValue(), 42);
    }

    function testProcessUEIRevertsForUnauthorizedCaller() public {
        address unauthorized = address(0x999);
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = bytes32("intent-1");
        address[] memory targets = new address[](1);
        targets[0] = address(0x789);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = bytes("data");

        vm.prank(unauthorized);
        vm.expectRevert("Not authorized");
        manager.processUEI(intentIds, new address[](0), targets, calldatas, new bytes[](0));
    }
}
