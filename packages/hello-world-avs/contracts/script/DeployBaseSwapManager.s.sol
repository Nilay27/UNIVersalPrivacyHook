// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {BaseSwapManager} from "../src/BaseSwapManager.sol";
import {SimpleBoringVault} from "../src/SimpleBoringVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20Extended is IERC20 {
    function decimals() external view returns (uint8);
}

contract DeployBaseSwapManager is Script {
    using stdJson for string;

    address internal deployer;
    uint256 internal chainId;

    function setUp() public virtual {
        deployer = vm.rememberKey(vm.envUint("PRIVATE_KEY"));
        chainId = block.chainid;
        vm.label(deployer, "Deployer");
    }

    function run() external {
        vm.startBroadcast(deployer);

        string memory basePath = "deployments/";
        string memory vaultPath = string.concat(basePath, "boring-vault/", vm.toString(chainId), ".json");
        require(vm.exists(vaultPath), "Boring vault deployment file missing");
        string memory vaultJson = vm.readFile(vaultPath);
        address payable boringVault = payable(vaultJson.readAddress(".addresses.SimpleBoringVault"));

        console2.log("Deploying BaseSwapManager on chain", chainId);
        console2.log("Deployer:", deployer);
        console2.log("Existing BoringVault:", boringVault);

        BaseSwapManager manager = new BaseSwapManager(deployer, boringVault);
        console2.log("BaseSwapManager deployed at:", address(manager));

        SimpleBoringVault(boringVault).setExecutor(address(manager), true);
        console2.log("Vault executor updated");

        manager.setCallerAuthorization(deployer, true);
        console2.log("Deployer authorized");

        string memory tokensPath = string.concat(basePath, "mocks/", vm.toString(chainId), ".json");
        if (vm.exists(tokensPath)) {
            string memory tokensJson = vm.readFile(tokensPath);
            string[] memory tokenKeys = vm.parseJsonKeys(tokensJson, ".tokens");
            if (tokenKeys.length == 0) {
                tokenKeys = new string[](5);
                tokenKeys[0] = "USDC";
                tokenKeys[1] = "USDT";
                tokenKeys[2] = "PT_eUSDE";
                tokenKeys[3] = "PT_sUSDE";
                tokenKeys[4] = "PT_USR";
            }
            for (uint256 i = 0; i < tokenKeys.length; ++i) {
                string memory key = tokenKeys[i];
                address token = tokensJson.readAddress(string.concat(".tokens.", key));
                uint8 decimals;
                try IERC20Extended(token).decimals() returns (uint8 dec) {
                    decimals = dec;
                } catch {
                    decimals = 6;
                }
                uint256 amount = 100_000 * (10 ** decimals);
                console2.log("Seeding", amount, "units for token", token);
                (bool success, ) = token.call(abi.encodeWithSignature("mint(address,uint256)", boringVault, amount));
                if (!success) {
                    console2.log("Mint failed, attempting transfer", token);
                    try IERC20(token).transfer(boringVault, amount) {} catch {
                        console2.log("Transfer also failed", token);
                    }
                }
            }
        } else {
            console2.log("No tokens deployment file found; skipping mint");
        }

        _writeDeployment(address(manager), boringVault);

        vm.stopBroadcast();
    }

    function _writeDeployment(address manager, address boringVault) internal {
        string memory lastUpdate = "lastUpdate";
        vm.serializeString(lastUpdate, "timestamp", vm.toString(block.timestamp));
        string memory lastUpdateJson = vm.serializeString(lastUpdate, "block_number", vm.toString(block.number));

        string memory addresses = "addresses";
        vm.serializeAddress(addresses, "baseSwapManager", manager);
        vm.serializeAddress(addresses, "boringVault", boringVault);
        vm.serializeAddress(addresses, "admin", BaseSwapManager(manager).admin());
        string memory addressesJson = vm.serializeAddress(addresses, "deployer", deployer);

        string memory root = "root";
        vm.serializeString(root, "lastUpdate", lastUpdateJson);
        string memory finalJson = vm.serializeString(root, "addresses", addressesJson);

        string memory outputDir = "deployments/base-swap-manager";
        if (!vm.exists(outputDir)) {
            vm.createDir(outputDir, true);
        }
        string memory outputFile = string.concat(outputDir, "/", vm.toString(chainId), ".json");
        vm.writeJson(finalJson, outputFile);
        console2.log("Deployment info written to:", outputFile);
    }
}
