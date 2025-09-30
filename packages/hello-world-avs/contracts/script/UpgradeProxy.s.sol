// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "forge-std/Script.sol";
import "../src/SwapManager.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract UpgradeProxy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Upgrading SwapManager proxy...");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Addresses
        address newImplementation = 0xdD144eC155e28516715B9C9810981ece9f40Ae3e;
        address proxyAddress = 0x9DbA075FAD6be58cf0De872d53EC52bB79a7c461;
        address proxyAdminAddress = 0x6eC553091d057012897168b2FA9af1e2EaD09838;

        console.log("New implementation:", newImplementation);
        console.log("Proxy:", proxyAddress);
        console.log("ProxyAdmin:", proxyAdminAddress);

        // Upgrade the proxy
        ProxyAdmin proxyAdmin = ProxyAdmin(proxyAdminAddress);

        console.log("Calling upgrade...");
        proxyAdmin.upgrade(
            ITransparentUpgradeableProxy(proxyAddress),
            newImplementation
        );

        console.log("Proxy upgraded successfully!");

        // Try to register operator if not already registered
        SwapManager swapManager = SwapManager(proxyAddress);
        if (!swapManager.isOperatorRegistered(deployer)) {
            console.log("Registering operator...");
            swapManager.registerOperatorForBatches();
            console.log("Operator registered!");
        } else {
            console.log("Operator already registered");
        }

        vm.stopBroadcast();

        console.log("\n=== Upgrade Complete ===");
        console.log("SwapManager proxy:", proxyAddress);
        console.log("New implementation:", newImplementation);
        console.log("Operator registered:", deployer);
    }
}