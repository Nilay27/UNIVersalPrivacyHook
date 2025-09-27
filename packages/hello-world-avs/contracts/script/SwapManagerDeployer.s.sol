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

import {
    IECDSAStakeRegistryTypes,
    IStrategy
} from "@eigenlayer-middleware/src/interfaces/IECDSAStakeRegistry.sol";

import "forge-std/Test.sol";

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
