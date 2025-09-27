// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../src/MockPrivacyHook.sol";
import "../src/SwapManager.sol";
import "../src/ISwapManager.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract TestRealScenario is Test {
    MockPrivacyHook public hook;
    SwapManager public swapManager;
    
    address constant USER1 = address(0x1);
    address constant USER2 = address(0x2);
    address constant USER3 = address(0x3);
    
    address constant USDC = address(0x0000000000000000000000000000000000000001);
    address constant USDT = address(0x0000000000000000000000000000000000000002);
    address constant WETH = address(0x0000000000000000000000000000000000000003);
    
    function setUp() public {
        // Deploy fresh SwapManager with mock addresses for EigenLayer components
        address mockAvsDirectory = address(0x1000);
        address mockStakeRegistry = address(0x2000);
        address mockRewardsCoordinator = address(0x3000);
        address mockDelegationManager = address(0x4000);
        address mockAllocationManager = address(0x5000);
        uint32 maxResponseIntervalBlocks = 100;
        
        // Deploy ProxyAdmin
        ProxyAdmin proxyAdmin = new ProxyAdmin();
        
        // Deploy SwapManager implementation
        SwapManager swapManagerImpl = new SwapManager(
            mockAvsDirectory,
            mockStakeRegistry,
            mockRewardsCoordinator,
            mockDelegationManager,
            mockAllocationManager,
            maxResponseIntervalBlocks
        );
        
        // Deploy proxy with empty initialization
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(swapManagerImpl),
            address(proxyAdmin),
            ""
        );
        
        // Cast proxy to SwapManager
        swapManager = SwapManager(address(proxy));
        
        // Initialize SwapManager with this test contract as owner
        swapManager.initialize(address(this), address(this));
        
        // Deploy fresh MockPrivacyHook
        hook = new MockPrivacyHook(address(swapManager));
        
        // Authorize the hook
        swapManager.authorizeHook(address(hook));
    }
    
    function testRealScenario() public {
        console.log("\n=== TEST: Real Scenario - Manual Finalization + New Intents ===");
        
        // Submit first 3 intents
        console.log("\n--- Submitting first 3 intents ---");
        
        vm.prank(USER1);
        bytes32 intent1 = hook.submitIntent(USDC, USDT, abi.encode(1000));
        console.log("Intent 1 submitted");
        
        vm.prank(USER2);
        bytes32 intent2 = hook.submitIntent(USDT, USDC, abi.encode(800));
        console.log("Intent 2 submitted");
        
        vm.prank(USER3);
        bytes32 intent3 = hook.submitIntent(WETH, USDC, abi.encode(2));
        console.log("Intent 3 submitted");
        
        bytes32 batchId1 = hook.currentBatchId();
        console.log("Current batch ID:", uint256(batchId1));
        
        // Manually finalize the batch
        console.log("\n--- Manually finalizing batch ---");
        hook.finalizeBatch();
        console.log("Batch finalized successfully");
        
        // Check batch state after finalization
        MockPrivacyHook.Batch memory batch1 = hook.getBatch(batchId1);
        console.log("Batch status after finalization:", uint256(batch1.status));
        console.log("Current batch ID after finalization:", uint256(hook.currentBatchId()));
        
        // Now try to submit 4th and 5th intents
        console.log("\n--- Submitting 4th intent after manual finalization ---");
        
        vm.prank(USER1);
        try hook.submitIntent(USDC, WETH, abi.encode(3000)) returns (bytes32 intent4) {
            console.log("SUCCESS: Intent 4 submitted");
            console.log("New batch ID:", uint256(hook.currentBatchId()));
            
            // Try 5th intent
            console.log("\n--- Submitting 5th intent ---");
            vm.prank(USER2);
            try hook.submitIntent(USDT, WETH, abi.encode(500)) returns (bytes32 intent5) {
                console.log("SUCCESS: Intent 5 submitted");
                
                // Check final state
                bytes32 currentBatch = hook.currentBatchId();
                MockPrivacyHook.Batch memory finalBatch = hook.getBatch(currentBatch);
                console.log("\nFinal batch state:");
                console.log("- Batch ID:", uint256(currentBatch));
                console.log("- Intent count:", finalBatch.intentIds.length);
                console.log("- Status:", uint256(finalBatch.status));
            } catch Error(string memory reason) {
                console.log("FAILED: Intent 5 failed with:", reason);
            } catch {
                console.log("FAILED: Intent 5 failed with unknown error");
            }
        } catch Error(string memory reason) {
            console.log("FAILED: Intent 4 failed with:", reason);
        } catch {
            console.log("FAILED: Intent 4 failed with unknown error");
        }
    }
}