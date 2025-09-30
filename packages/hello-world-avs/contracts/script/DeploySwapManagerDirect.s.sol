// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/Test.sol";
import {SwapManager} from "../src/SwapManager.sol";
import {ECDSAStakeRegistry} from "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import {CoreDeployLib, CoreDeploymentParsingLib} from "./utils/CoreDeploymentParsingLib.sol";
import {SwapManagerDeploymentLib} from "./utils/SwapManagerDeploymentLib.sol";

interface IUniversalPrivacyHook {
    function setSwapManager(address _swapManager) external;
    function owner() external view returns (address);
}

/**
 * @title DeploySwapManagerDirect
 * @notice Deploys SwapManager as a NON-UPGRADEABLE contract (no proxy)
 * @dev This fixes the SepoliaConfig immutable variable issue with proxies
 */
contract DeploySwapManagerDirect is Script {
    address internal deployer;
    CoreDeployLib.DeploymentData coreDeployment;
    SwapManagerDeploymentLib.DeploymentConfigData swapManagerConfig;

    // UniversalPrivacyHook address on Sepolia
    address constant UNIVERSAL_PRIVACY_HOOK = 0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080;

    function setUp() public virtual {
        deployer = vm.rememberKey(vm.envUint("PRIVATE_KEY"));
        vm.label(deployer, "Deployer");

        swapManagerConfig =
            SwapManagerDeploymentLib.readDeploymentConfigValues("config/swap-manager/", block.chainid);

        coreDeployment =
            CoreDeploymentParsingLib.readDeploymentJson("deployments/core/", block.chainid);
    }

    function run() external virtual {
        vm.startBroadcast(deployer);

        console2.log("\n=== Deploying NON-UPGRADEABLE SwapManager ===");
        console2.log("Deployer:", deployer);
        console2.log("Rewards Owner:", swapManagerConfig.rewardsOwner);
        console2.log("Rewards Initiator:", swapManagerConfig.rewardsInitiator);

        // Read existing deployment to get stake registry
        SwapManagerDeploymentLib.DeploymentData memory existingDeployment =
            SwapManagerDeploymentLib.readDeploymentJson("deployments/swap-manager/", block.chainid);

        console2.log("\nUsing existing StakeRegistry:", existingDeployment.stakeRegistry);

        // Deploy SwapManager directly (NO PROXY)
        SwapManager swapManager = new SwapManager(
            coreDeployment.avsDirectory,
            existingDeployment.stakeRegistry,
            coreDeployment.rewardsCoordinator,
            coreDeployment.delegationManager,
            coreDeployment.allocationManager,
            4, // MAX_RESPONSE_INTERVAL_BLOCKS
            swapManagerConfig.rewardsOwner // admin
        );

        console2.log("\nSwapManager deployed at:", address(swapManager));

        // Note: For non-upgradeable contracts, initialization happens in constructor
        // No need to call initialize() separately

        // Verify admin
        console2.log("\nVerifying admin...");
        address currentAdmin = swapManager.admin();
        console2.log("Current admin:", currentAdmin);
        require(currentAdmin == swapManagerConfig.rewardsOwner, "Admin mismatch");

        // Authorize the UniversalPrivacyHook
        console2.log("\nAuthorizing UniversalPrivacyHook in SwapManager...");
        swapManager.authorizeHook(UNIVERSAL_PRIVACY_HOOK);
        console2.log("Hook authorized");


        IUniversalPrivacyHook(UNIVERSAL_PRIVACY_HOOK).setSwapManager(address(swapManager));
        console2.log("SwapManager set in hook");

        vm.stopBroadcast();

        console2.log("\n=== Deployment Complete ===");
        console2.log("SwapManager (non-upgradeable):", address(swapManager));
        console2.log("StakeRegistry:", existingDeployment.stakeRegistry);
        console2.log("UniversalPrivacyHook:", UNIVERSAL_PRIVACY_HOOK);

        // Write deployment info
        writeDeploymentInfo(address(swapManager), existingDeployment);
    }

    function writeDeploymentInfo(
        address swapManager,
        SwapManagerDeploymentLib.DeploymentData memory existingDeployment
    ) internal {
        string memory outputPath = "deployments/swap-manager/";
        string memory fileName = string.concat(outputPath, vm.toString(block.chainid), ".json");

        string memory json = string.concat(
            '{"lastUpdate":{"timestamp":"',
            vm.toString(block.timestamp),
            '","block_number":"',
            vm.toString(block.number),
            '"},"addresses":{"SwapManager":"',
            vm.toString(swapManager),
            '","SwapManagerType":"direct-non-upgradeable","stakeRegistry":"',
            vm.toString(existingDeployment.stakeRegistry),
            '","universalPrivacyHook":"',
            vm.toString(UNIVERSAL_PRIVACY_HOOK),
            '","strategy":"',
            vm.toString(existingDeployment.strategy),
            '","token":"',
            vm.toString(existingDeployment.token),
            '"}}'
        );

        if (!vm.exists(outputPath)) {
            vm.createDir(outputPath, true);
        }

        vm.writeFile(fileName, json);
        console2.log("\nDeployment info written to:", fileName);
    }
}