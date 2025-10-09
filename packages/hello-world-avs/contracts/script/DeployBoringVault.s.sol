// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/Test.sol";
import {SimpleBoringVault} from "../src/SimpleBoringVault.sol";

interface ISwapManager {
    function setBoringVault(address payable _vault) external;
    function admin() external view returns (address);
}

/**
 * @title DeployBoringVault
 * @notice Deploys SimpleBoringVault and configures it with SwapManager
 */
contract DeployBoringVault is Script {
    address internal deployer;

    // Deployed contract addresses on Sepolia
    address constant UNIVERSAL_PRIVACY_HOOK = 0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080;
    address constant SWAP_MANAGER = 0xE1e00b5d08a08Cb141a11a922e48D4c06d66D3bf;

    function setUp() public virtual {
        deployer = vm.rememberKey(vm.envUint("PRIVATE_KEY"));
        vm.label(deployer, "Deployer");
    }

    function run() external virtual {
        vm.startBroadcast(deployer);

        console2.log("\n=== Deploying SimpleBoringVault ===");
        console2.log("Deployer:", deployer);
        console2.log("UniversalPrivacyHook:", UNIVERSAL_PRIVACY_HOOK);
        console2.log("SwapManager (tradeManager):", SWAP_MANAGER);

        // Deploy SimpleBoringVault
        // Constructor params: hook, tradeManager
        SimpleBoringVault vault = new SimpleBoringVault(
            UNIVERSAL_PRIVACY_HOOK,
            SWAP_MANAGER  // tradeManager = SwapManager
        );

        console2.log("\nSimpleBoringVault deployed at:", address(vault));

        // Verify configuration
        console2.log("\nVerifying vault configuration...");
        require(vault.hook() == UNIVERSAL_PRIVACY_HOOK, "Hook mismatch");
        require(vault.tradeManager() == SWAP_MANAGER, "TradeManager mismatch");
        console2.log("Hook:", vault.hook());
        console2.log("TradeManager:", vault.tradeManager());

        // Verify SwapManager is authorized
        require(vault.isAuthorized(SWAP_MANAGER), "SwapManager not authorized");
        console2.log("SwapManager authorized:", vault.isAuthorized(SWAP_MANAGER));

        // Set BoringVault address in SwapManager
        console2.log("\nSetting BoringVault in SwapManager...");
        ISwapManager(SWAP_MANAGER).setBoringVault(payable(address(vault)));
        console2.log("BoringVault set in SwapManager");

        vm.stopBroadcast();

        console2.log("\n=== Deployment Complete ===");
        console2.log("SimpleBoringVault:", address(vault));
        console2.log("\nAuthorization Summary:");
        console2.log("- Hook can execute:", vault.isAuthorized(UNIVERSAL_PRIVACY_HOOK));
        console2.log("- SwapManager can execute:", vault.isAuthorized(SWAP_MANAGER));
        console2.log("\nIntegration Status:");
        console2.log("- Hook can deposit: vault.deposit(token, amount)");
        console2.log("- SwapManager can execute UEI: vault.execute(target, data, value)");
        console2.log("- SwapManager.processUEI() -> vault.execute() -> target protocol");

        // Write deployment info
        writeDeploymentInfo(address(vault));
    }

    function writeDeploymentInfo(address vault) internal {
        string memory outputPath = "deployments/boring-vault/";
        string memory fileName = string.concat(outputPath, vm.toString(block.chainid), ".json");

        string memory json = string.concat(
            '{"lastUpdate":{"timestamp":"',
            vm.toString(block.timestamp),
            '","block_number":"',
            vm.toString(block.number),
            '"},"addresses":{"SimpleBoringVault":"',
            vm.toString(vault),
            '","hook":"',
            vm.toString(UNIVERSAL_PRIVACY_HOOK),
            '","swapManager":"',
            vm.toString(SWAP_MANAGER),
            '"}}'
        );

        if (!vm.exists(outputPath)) {
            vm.createDir(outputPath, true);
        }

        vm.writeFile(fileName, json);
        console2.log("\nDeployment info written to:", fileName);
    }
}
