// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/Test.sol";
import "../src/MockPrivacyHook.sol";
import "../src/SwapManager.sol";

contract DeployWithMockHook is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        // Read the existing SwapManager deployment
        uint256 chainId = block.chainid;
        string memory deploymentFile = string.concat(
            "deployments/swap-manager/",
            vm.toString(chainId),
            ".json"
        );
        
        string memory json = vm.readFile(deploymentFile);
        address swapManagerAddress = vm.parseJsonAddress(json, ".addresses.SwapManager");
        
        console2.log("Using SwapManager at:", swapManagerAddress);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy MockPrivacyHook
        MockPrivacyHook mockHook = new MockPrivacyHook(swapManagerAddress);
        console2.log("MockPrivacyHook deployed at:", address(mockHook));
        
        // Authorize the MockPrivacyHook in SwapManager
        SwapManager swapManager = SwapManager(swapManagerAddress);
        swapManager.authorizeHook(address(mockHook));
        console2.log("MockPrivacyHook authorized in SwapManager");
        
        vm.stopBroadcast();
        
        // Save MockHook deployment to file in proper format
        string memory parent = "parent";
        string memory lastUpdate = "lastUpdate";
        string memory addresses = "addresses";
        
        // Create lastUpdate object
        vm.serializeString(lastUpdate, "timestamp", vm.toString(block.timestamp));
        string memory lastUpdateJson = vm.serializeString(lastUpdate, "block_number", vm.toString(block.number));
        
        // Create addresses object
        vm.serializeAddress(addresses, "mockPrivacyHook", address(mockHook));
        string memory addressesJson = vm.serializeAddress(addresses, "swapManager", swapManagerAddress);
        
        // Combine into parent object
        vm.serializeString(parent, "lastUpdate", lastUpdateJson);
        string memory finalJson = vm.serializeString(parent, "addresses", addressesJson);
        
        string memory outputFile = string.concat(
            "deployments/mock-hook/",
            vm.toString(chainId),
            ".json"
        );
        vm.writeJson(finalJson, outputFile);
        
        console2.log("\n=== Deployment Complete ===");
        console2.log("SwapManager:", swapManagerAddress);
        console2.log("MockPrivacyHook:", address(mockHook));
        console2.log("Authorization: MockPrivacyHook authorized to submit batches");
        console2.log("Saved to:", outputFile);
    }
}