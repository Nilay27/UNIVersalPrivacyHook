// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "forge-std/Script.sol";
import "../src/SwapManager.sol";

contract DeployOnlySwapManager is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying modified SwapManager implementation...");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Use existing deployment parameters from 11155111.json
        address stakeRegistry = 0x5e1d1eF93E59A62501f3D79A569abE2054D9091a;
        address delegationManager = 0x8C9fC854Aed89C7c63FD8f19095d0D96b80C7FD1;
        address universalPrivacyHook = 0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080;
        address exprLibraryAddress = 0xbE088827fA91E04C8C5c50076Fa7D13a3E039E5B;
        address rewardsOwner = deployer; // Using deployer as rewards owner
        uint32 stalenessBlocks = 50;

        // Deploy new implementation with all required parameters
        SwapManager newImplementation = new SwapManager(
            stakeRegistry,
            delegationManager,
            universalPrivacyHook,
            exprLibraryAddress,
            rewardsOwner,
            stalenessBlocks,
            deployer // admin
        );

        console.log("New SwapManager implementation deployed at:", address(newImplementation));

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
        console.log("New Implementation:", address(newImplementation));
        console.log("\nNext step: Upgrade proxy at 0x9DbA075FAD6be58cf0De872d53EC52bB79a7c461 to use this implementation");
    }
}