// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../src/MockPrivacyHook.sol";
import "../src/SwapManager.sol";
import "../src/ISwapManager.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract MockPrivacyHookDebugTest is Test {
    MockPrivacyHook public hook;
    SwapManager public swapManager;
    
    address constant USER1 = address(0x1);
    address constant USER2 = address(0x2);
    address constant OPERATOR = address(0x100);
    
    address constant USDC = address(0x0000000000000000000000000000000000000001);
    address constant USDT = address(0x0000000000000000000000000000000000000002);
    address constant WETH = address(0x0000000000000000000000000000000000000003);
    
    function setUp() public {
        console.log("\n=== SETUP PHASE ===");
        
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
        
        console.log("SwapManager deployed at:", address(swapManager));
        console.log("SwapManager owner:", swapManager.owner());
        
        // Deploy fresh MockPrivacyHook
        hook = new MockPrivacyHook(address(swapManager));
        console.log("MockPrivacyHook deployed at:", address(hook));
        
        // Authorize the hook - now we are the owner
        swapManager.authorizeHook(address(hook));
        console.log("Hook authorized:", swapManager.authorizedHooks(address(hook)));
        
        // Check initial state
        console.log("Initial currentBatchId:", uint256(hook.currentBatchId()));
        console.log("Initial lastBatchBlock:", hook.lastBatchBlock());
        console.log("Batch block interval:", hook.batchBlockInterval());
    }
    
    function testBatchAutoFinalization() public {
        console.log("\n=== TEST: Batch Auto-Finalization ===");
        console.log("Starting block:", block.number);
        
        // Submit first 3 intents (should work fine)
        console.log("\n--- Submitting first 3 intents ---");
        
        vm.prank(USER1);
        bytes32 intent1 = hook.submitIntent(USDC, USDT, abi.encode(1000));
        console.log("Intent 1 submitted:", uint256(intent1));
        console.log("Current batch:", uint256(hook.currentBatchId()));
        console.log("Current block:", block.number);
        
        vm.prank(USER2);
        bytes32 intent2 = hook.submitIntent(USDT, USDC, abi.encode(800));
        console.log("Intent 2 submitted:", uint256(intent2));
        
        vm.prank(USER1);
        bytes32 intent3 = hook.submitIntent(WETH, USDC, abi.encode(2));
        console.log("Intent 3 submitted:", uint256(intent3));
        
        // Check batch state
        bytes32 batchId = hook.currentBatchId();
        MockPrivacyHook.Batch memory batch = hook.getBatch(batchId);
        console.log("\nBatch state after 3 intents:");
        console.log("- Batch ID:", uint256(batchId));
        console.log("- Intent count:", batch.intentIds.length);
        console.log("- Status:", uint256(batch.status));
        console.log("- Created at:", batch.createdAt);
        
        // Now advance blocks to trigger auto-finalization
        console.log("\n--- Advancing blocks to trigger auto-finalization ---");
        console.log("Current block before roll:", block.number);
        console.log("Last batch block:", hook.lastBatchBlock());
        console.log("Need to reach block:", hook.lastBatchBlock() + hook.batchBlockInterval());
        
        // Move forward 5 blocks
        vm.roll(block.number + 5);
        console.log("Rolled to block:", block.number);
        
        // Try to submit 4th intent - this should trigger auto-finalization
        console.log("\n--- Attempting 4th intent (should trigger auto-finalization) ---");
        
        // First, let's check what will happen in _getOrCreateBatch
        console.log("Conditions check:");
        console.log("- currentBatchId != 0:", hook.currentBatchId() != bytes32(0));
        console.log("- block.number >= lastBatchBlock + interval:", block.number >= hook.lastBatchBlock() + hook.batchBlockInterval());
        
        // Check the old batch state before attempting
        bytes32 oldBatchId = hook.currentBatchId();
        MockPrivacyHook.Batch memory oldBatch = hook.getBatch(oldBatchId);
        console.log("\nOld batch state before 4th intent:");
        console.log("- Old batch ID:", uint256(oldBatchId));
        console.log("- Old batch intent count:", oldBatch.intentIds.length);
        console.log("- Old batch status:", uint256(oldBatch.status));
        
        // Check if batch exists in SwapManager
        console.log("\n--- Checking SwapManager state ---");
        // Batch struct has: batchId, intentIds[], poolId, hook, createdBlock, finalizedBlock, status
        // But public mapping returns all fields except arrays
        (bytes32 smBatchId, address poolId, address hookAddr, uint32 createdBlock, 
         uint32 finalizedBlock, ISwapManager.BatchStatus smStatus) = swapManager.batches(oldBatchId);
        console.log("SwapManager batch state:");
        console.log("- Batch ID in SM:", uint256(smBatchId));
        console.log("- Status in SM:", uint256(smStatus));
        if (smBatchId == bytes32(0)) {
            console.log("- Batch DOES NOT exist in SwapManager (good for first finalization)");
        } else {
            console.log("- Batch EXISTS in SwapManager (will cause revert!)");
        }
        
        // Check if hook is authorized
        console.log("\nHook authorization check:");
        console.log("- Hook authorized:", swapManager.authorizedHooks(address(hook)));
        
        // Now try the 4th intent and see what happens
        console.log("\n--- Submitting 4th intent ---");
        
        // Let's trace exactly what should happen:
        // 1. submitIntent calls _getOrCreateBatch
        // 2. _getOrCreateBatch sees currentBatchId != 0 and block >= lastBatchBlock + interval
        // 3. It should call _finalizeBatchInternal on the old batch
        // 4. _finalizeBatchInternal calls swapManager.finalizeBatch
        // 5. Then _createNewBatch creates a new batch
        // 6. The intent gets added to the new batch
        
        console.log("About to call submitIntent, expecting auto-finalization...");
        
        vm.prank(USER1);
        try hook.submitIntent(USDC, WETH, abi.encode(3000)) returns (bytes32 intent4) {
            console.log("SUCCESS: Intent 4 submitted:", uint256(intent4));
            console.log("New batch ID:", uint256(hook.currentBatchId()));
            
            // Try the 5th intent to see if it works in the new batch
            console.log("\n--- Submitting 5th intent in new batch ---");
            vm.prank(USER2);
            try hook.submitIntent(USDT, WETH, abi.encode(500)) returns (bytes32 intent5) {
                console.log("SUCCESS: Intent 5 submitted:", uint256(intent5));
                console.log("Current batch ID:", uint256(hook.currentBatchId()));
            } catch Error(string memory reason5) {
                console.log("FAILED: Intent 5 failed with reason:", reason5);
            } catch {
                console.log("FAILED: Intent 5 failed with unknown error");
            }
        } catch Error(string memory reason) {
            console.log("FAILED with reason:", reason);
        } catch (bytes memory lowLevelData) {
            console.log("FAILED with low-level error");
            console.logBytes(lowLevelData);
            
            // Check what happened to the old batch
            MockPrivacyHook.Batch memory oldBatchAfter = hook.getBatch(oldBatchId);
            console.log("\nOld batch state after failed attempt:");
            console.log("- Status:", uint256(oldBatchAfter.status));
            
            // Check if SwapManager has the batch now
            (bytes32 smBatchIdAfter, , , , , ISwapManager.BatchStatus smStatusAfter) = 
                swapManager.batches(oldBatchId);
            console.log("SwapManager batch after failed attempt:");
            console.log("- Batch ID:", uint256(smBatchIdAfter));
            console.log("- Status:", uint256(smStatusAfter));
        }
    }
    
    function testManualBatchFinalization() public {
        console.log("\n=== TEST: Manual Batch Finalization ===");
        
        // Submit 3 intents
        vm.prank(USER1);
        hook.submitIntent(USDC, USDT, abi.encode(1000));
        
        vm.prank(USER2);
        hook.submitIntent(USDT, USDC, abi.encode(800));
        
        vm.prank(USER1);
        hook.submitIntent(WETH, USDC, abi.encode(2));
        
        bytes32 batchId = hook.currentBatchId();
        console.log("Batch ID to finalize:", uint256(batchId));
        
        // Check if batch is ready
        console.log("Is batch ready?", hook.isBatchReady());
        
        // Try manual finalization
        console.log("\n--- Attempting manual finalization ---");
        try hook.finalizeBatch() {
            console.log("SUCCESS: Batch finalized manually");
            
            // Check SwapManager state after
            (bytes32 smBatchId, , , , , ISwapManager.BatchStatus smStatus) = 
                swapManager.batches(batchId);
            console.log("SwapManager after finalization:");
            console.log("- Batch ID:", uint256(smBatchId));
            console.log("- Status:", uint256(smStatus));
        } catch Error(string memory reason) {
            console.log("FAILED with reason:", reason);
        } catch {
            console.log("FAILED with unknown error");
        }
    }
    
    function testDirectFinalizeBatch() public {
        console.log("\n=== TEST: Direct finalizeBatch Call ===");
        
        // Submit one intent to create a batch
        vm.prank(USER1);
        hook.submitIntent(USDC, USDT, abi.encode(1000));
        
        bytes32 batchId = hook.currentBatchId();
        console.log("Batch ID:", uint256(batchId));
        
        // Try to call finalizeBatch directly on SwapManager from the hook
        bytes memory batchData = abi.encode(
            new bytes32[](1),
            address(hook)
        );
        
        console.log("Calling SwapManager.finalizeBatch directly from hook...");
        vm.prank(address(hook));
        try swapManager.finalizeBatch(batchId, batchData) {
            console.log("SUCCESS: Direct finalizeBatch worked");
        } catch Error(string memory reason) {
            console.log("FAILED with reason:", reason);
        } catch {
            console.log("FAILED with unknown error");
        }
    }
    
    function testDoubleFinalization() public {
        console.log("\n=== TEST: Double Finalization ===");
        
        // Submit intents and finalize once
        vm.prank(USER1);
        hook.submitIntent(USDC, USDT, abi.encode(1000));
        
        bytes32 batchId = hook.currentBatchId();
        
        // First finalization
        console.log("First finalization attempt:");
        hook.finalizeBatch();
        console.log("SUCCESS");
        
        // Check status in both contracts
        MockPrivacyHook.Batch memory hookBatch = hook.getBatch(batchId);
        (bytes32 smBatchId, , , , , ISwapManager.BatchStatus smStatus) = 
            swapManager.batches(batchId);
        console.log("After first finalization:");
        console.log("- Hook status:", uint256(hookBatch.status));
        console.log("- SwapManager batch ID:", uint256(smBatchId));
        console.log("- SwapManager status:", uint256(smStatus));
        
        // Create a new batch with same ID (simulating restart)
        vm.roll(block.number + 10);
        vm.prank(USER1);
        hook.submitIntent(USDC, USDT, abi.encode(2000));
        
        // Try to finalize the same batch ID again
        console.log("\nSecond finalization attempt (should fail):");
        try hook.finalizeBatch() {
            console.log("SUCCESS (unexpected!)");
        } catch Error(string memory reason) {
            console.log("FAILED with reason:", reason);
        }
    }
}