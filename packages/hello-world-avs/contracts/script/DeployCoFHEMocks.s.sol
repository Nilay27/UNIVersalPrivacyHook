// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Script.sol";
import "../lib/cofhe-mocks/MockZkVerifier.sol";
import "../lib/cofhe-mocks/MockQueryDecrypter.sol";
import "../lib/cofhe-mocks/MockTaskManager.sol";
import "../lib/cofhe-mocks/ACL.sol";

/**
 * @title DeployCoFHEMocks
 * @notice Deploys mock contracts required for CoFHE.js to work in MOCK mode
 */
contract DeployCoFHEMocks is Script {
    function run() external {
        vm.startBroadcast();
        
        // Deploy ACL first (needed by other contracts)
        // ACL needs an initial owner address
        ACL acl = new ACL(msg.sender);
        console.log("ACL deployed at:", address(acl));
        
        // Deploy TaskManager
        TaskManager taskManager = new TaskManager();
        console.log("TaskManager deployed at:", address(taskManager));
        taskManager.initialize(address(acl));
        
        // Deploy MockZkVerifier
        MockZkVerifier zkVerifier = new MockZkVerifier();
        console.log("MockZkVerifier deployed at:", address(zkVerifier));
        
        // Deploy MockQueryDecrypter
        MockQueryDecrypter queryDecrypter = new MockQueryDecrypter();
        console.log("MockQueryDecrypter deployed at:", address(queryDecrypter));
        queryDecrypter.initialize(address(taskManager), address(acl));
        
        console.log("\n=== CoFHE Mock Contracts Deployed ===");
        console.log("Export these addresses for use with CoFHE.js:");
        console.log("MOCK_ZK_VERIFIER_ADDRESS=", address(zkVerifier));
        console.log("MOCK_QUERY_DECRYPTER_ADDRESS=", address(queryDecrypter));
        console.log("TASK_MANAGER_ADDRESS=", address(taskManager));
        console.log("ACL_ADDRESS=", address(acl));
        
        // Create the directory first (if it doesn't exist)
        vm.createDir("./deployments", true);
        vm.createDir("./deployments/cofhe-mocks", true);
        
        // Write to a JSON file for easy import
        string memory json = string.concat(
            '{"zkVerifier":"',
            vm.toString(address(zkVerifier)),
            '","queryDecrypter":"',
            vm.toString(address(queryDecrypter)),
            '","taskManager":"',
            vm.toString(address(taskManager)),
            '","acl":"',
            vm.toString(address(acl)),
            '"}'
        );
        
        vm.writeJson(json, "./deployments/cofhe-mocks/31337.json");
        console.log("\nAddresses saved to deployments/cofhe-mocks/31337.json");
        
        vm.stopBroadcast();
    }
}