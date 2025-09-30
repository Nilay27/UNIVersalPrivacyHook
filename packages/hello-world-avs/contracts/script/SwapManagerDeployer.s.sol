// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/Test.sol";
import {SwapManagerDeploymentLib} from "./utils/SwapManagerDeploymentLib.sol";
import {CoreDeployLib, CoreDeploymentParsingLib} from "./utils/CoreDeploymentParsingLib.sol";
import {UpgradeableProxyLib} from "./utils/UpgradeableProxyLib.sol";
import {StrategyBase} from "@eigenlayer/contracts/strategies/StrategyBase.sol";
import {ERC20Mock} from "../test/ERC20Mock.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {StrategyFactory} from "@eigenlayer/contracts/strategies/StrategyFactory.sol";
import {StrategyManager} from "@eigenlayer/contracts/core/StrategyManager.sol";
import {IRewardsCoordinator} from "@eigenlayer/contracts/interfaces/IRewardsCoordinator.sol";
import {SwapManager} from "../src/SwapManager.sol";

import {
    IECDSAStakeRegistryTypes,
    IStrategy
} from "@eigenlayer-middleware/src/interfaces/IECDSAStakeRegistry.sol";

import "forge-std/Test.sol";

interface IUniversalPrivacyHook {
    function setSwapManager(address _swapManager) external;
}

contract SwapManagerDeployer is Script, Test {
    using CoreDeployLib for *;
    using UpgradeableProxyLib for address;

    address internal deployer;
    address proxyAdmin;
    address rewardsOwner;
    address rewardsInitiator;
    IStrategy swapManagerStrategy;
    CoreDeployLib.DeploymentData coreDeployment;
    SwapManagerDeploymentLib.DeploymentData swapManagerDeployment;
    SwapManagerDeploymentLib.DeploymentConfigData swapManagerConfig;
    IECDSAStakeRegistryTypes.Quorum internal quorum;
    ERC20Mock token;

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
        rewardsOwner = swapManagerConfig.rewardsOwner;
        rewardsInitiator = swapManagerConfig.rewardsInitiator;

        token = new ERC20Mock();
        // NOTE: if this fails, it's because the initialStrategyWhitelister is not set to be the StrategyFactory
        swapManagerStrategy =
            IStrategy(StrategyFactory(coreDeployment.strategyFactory).deployNewStrategy(token));

        quorum.strategies.push(
            IECDSAStakeRegistryTypes.StrategyParams({
                strategy: swapManagerStrategy,
                multiplier: 10_000
            })
        );

        token.mint(deployer, 2000);
        token.increaseAllowance(address(coreDeployment.strategyManager), 1000);
        StrategyManager(coreDeployment.strategyManager).depositIntoStrategy(
            swapManagerStrategy, token, 1000
        );

        proxyAdmin = UpgradeableProxyLib.deployProxyAdmin();

        swapManagerDeployment = SwapManagerDeploymentLib.deployContracts(
            proxyAdmin, coreDeployment, quorum, rewardsInitiator, rewardsOwner
        );

        swapManagerDeployment.strategy = address(swapManagerStrategy);
        swapManagerDeployment.token = address(token);

        // Set the SwapManager address in UniversalPrivacyHook
        console2.log("Setting SwapManager in UniversalPrivacyHook...");
        IUniversalPrivacyHook(UNIVERSAL_PRIVACY_HOOK).setSwapManager(swapManagerDeployment.SwapManager);
        console2.log("SwapManager set successfully!");

        // Check who the admin is
        console2.log("Checking admin of SwapManager...");
        address currentAdmin = SwapManager(swapManagerDeployment.SwapManager).admin();
        console2.log("Current admin:", currentAdmin);
        console2.log("Deployer address:", deployer);
        console2.log("RewardsOwner address:", rewardsOwner);
        console2.log("msg.sender:", msg.sender);

        // Also authorize the hook in SwapManager
        console2.log("Authorizing UniversalPrivacyHook in SwapManager...");
        SwapManager(swapManagerDeployment.SwapManager).authorizeHook(UNIVERSAL_PRIVACY_HOOK);
        console2.log("Hook authorized successfully!");

        vm.stopBroadcast();
        verifyDeployment();
        SwapManagerDeploymentLib.writeDeploymentJson(swapManagerDeployment);
    }

    function verifyDeployment() internal view {
        require(
            swapManagerDeployment.stakeRegistry != address(0), "StakeRegistry address cannot be zero"
        );
        require(
            swapManagerDeployment.SwapManager != address(0),
            "SwapManager address cannot be zero"
        );
        require(swapManagerDeployment.strategy != address(0), "Strategy address cannot be zero");
        require(proxyAdmin != address(0), "ProxyAdmin address cannot be zero");
        require(
            coreDeployment.delegationManager != address(0),
            "DelegationManager address cannot be zero"
        );
        require(coreDeployment.avsDirectory != address(0), "AVSDirectory address cannot be zero");
    }
}
