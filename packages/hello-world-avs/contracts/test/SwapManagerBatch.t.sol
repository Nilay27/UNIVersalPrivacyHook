// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.12;

import {Test} from "forge-std/Test.sol";
import {SwapManager} from "../src/SwapManager.sol";
import {ISwapManager} from "../src/ISwapManager.sol";
import {MockPrivacyHook} from "../src/MockPrivacyHook.sol";
import {FheType} from "@fhevm/solidity/lib/FheType.sol";

// Import the interface to access the structs
interface IUniversalPrivacyHookTypes {
    struct InternalTransfer {
        address to;
        address encToken;
        bytes32 encAmount;
    }

    struct UserShare {
        address user;
        uint128 shareNumerator;
        uint128 shareDenominator;
    }
}

// Mock FHE Coprocessor that always returns success
contract MockFHECoprocessor {
    // verifyCiphertext returns the input handle as verified handle
    function verifyCiphertext(
        bytes32 inputHandle,
        address,
        bytes memory,
        FheType
    ) external pure returns (bytes32) {
        // Return the same handle as "verified"
        return inputHandle;
    }
}

// Mock ACL contract for FHE permissions
contract MockACL {
    // allowTransient does nothing (just succeeds)
    function allowTransient(bytes32, address) external pure {}

    // allow does nothing (just succeeds)
    function allow(bytes32, address) external pure {}

    // allowThis does nothing (just succeeds)
    function allowThis(bytes32) external pure {}
}

contract SwapManagerBatchTest is Test {
    SwapManager public swapManager;
    MockPrivacyHook public mockHook;
    MockFHECoprocessor public mockCoprocessor;
    MockACL public mockACL;

    address owner = address(0x1);
    // Use vm.addr to get actual addresses from private keys
    address operator1 = vm.addr(2); // Private key 2
    address operator2 = vm.addr(3); // Private key 3
    address operator3 = vm.addr(4); // Private key 4
    address user1 = address(0x5);
    address tokenA = address(0x10);
    address tokenB = address(0x11);

    function setUp() public {
        // Mock other FHE precompile addresses first
        vm.etch(address(0x000000000000000000000000000000000000005d), hex"00");

        // Deploy mock FHE contracts
        mockCoprocessor = new MockFHECoprocessor();
        mockACL = new MockACL();

        // Etch the mock coprocessor at the FHE coprocessor address
        vm.etch(address(0x848B0066793BcC60346Da1F49049357399B8D595), address(mockCoprocessor).code);

        // Etch the mock ACL at the ACL address
        vm.etch(address(0x687820221192C5B662b25367F70076A37bc79b6c), address(mockACL).code);

        // Deploy SwapManager AFTER etching mocks
        // Note: Constructor sets admin, no need for initialize() in tests
        swapManager = new SwapManager(
            address(0x100), // avsDirectory
            address(0x101), // stakeRegistry
            address(0x102), // rewardsCoordinator
            address(0x103), // delegationManager
            address(0x104), // allocationManager
            100, // maxResponseIntervalBlocks
            owner // admin
        );

        // Deploy MockPrivacyHook
        mockHook = new MockPrivacyHook(address(swapManager));

        // Authorize the hook
        vm.prank(owner);
        swapManager.authorizeHook(address(mockHook));

        // Register operators
        vm.prank(operator1);
        swapManager.registerOperatorForBatches();

        vm.prank(operator2);
        swapManager.registerOperatorForBatches();

        vm.prank(operator3);
        swapManager.registerOperatorForBatches();
    }

    function testBatchFinalization() public {
        // Create batch data matching UniversalPrivacyHook format
        bytes32[] memory intentIds = new bytes32[](2);
        intentIds[0] = keccak256("intent1");
        intentIds[1] = keccak256("intent2");

        bytes32 batchId = keccak256("batch1");
        bytes32 poolId = keccak256("pool1");

        // Create encrypted intent data
        bytes[] memory encryptedIntents = new bytes[](2);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000), // encAmount handle
            uint256(block.timestamp + 1 hours)
        );
        encryptedIntents[1] = abi.encode(
            intentIds[1],
            user1,
            tokenB,
            tokenA,
            uint256(500),
            uint256(block.timestamp + 1 hours)
        );

        bytes memory batchData = abi.encode(
            batchId,
            intentIds,
            poolId,
            address(mockHook),
            encryptedIntents
        );

        // Finalize batch
        vm.prank(address(mockHook));
        swapManager.finalizeBatch(batchId, batchData);

        // Check batch status
        ISwapManager.Batch memory batch = swapManager.getBatch(batchId);
        assertEq(uint(batch.status), uint(ISwapManager.BatchStatus.Processing));
        assertEq(batch.intentIds.length, 2);
        assertEq(batch.hook, address(mockHook));
        assertEq(batch.poolId, poolId);
    }

    function testBatchFinalizationRevertsIfNotAuthorizedHook() public {
        bytes32 batchId = keccak256("batch1");
        bytes memory batchData = "";

        // Try to finalize from unauthorized address
        vm.prank(address(0x999));
        vm.expectRevert("Unauthorized hook");
        swapManager.finalizeBatch(batchId, batchData);
    }

    function testBatchFinalizationRevertsIfInvalidStatus() public {
        // First finalize a batch
        bytes32 batchId = keccak256("batch1");
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = keccak256("intent1");
        bytes32 poolId = keccak256("pool1");

        bytes[] memory encryptedIntents = new bytes[](1);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000),
            uint256(block.timestamp + 1 hours)
        );

        bytes memory batchData = abi.encode(
            batchId,
            intentIds,
            poolId,
            address(mockHook),
            encryptedIntents
        );

        vm.prank(address(mockHook));
        swapManager.finalizeBatch(batchId, batchData);

        // Try to finalize again - should revert
        vm.prank(address(mockHook));
        vm.expectRevert("Invalid batch status");
        swapManager.finalizeBatch(batchId, batchData);
    }

    function testOperatorRegistration() public {
        address newOperator = address(0x99);

        assertFalse(swapManager.isOperatorRegistered(newOperator));

        vm.prank(newOperator);
        swapManager.registerOperatorForBatches();

        assertTrue(swapManager.isOperatorRegistered(newOperator));
    }

    function testGetOperatorCount() public {
        // Already registered 3 operators in setUp
        assertEq(swapManager.getOperatorCount(), 3);

        // Register one more
        address newOperator = address(0x99);
        vm.prank(newOperator);
        swapManager.registerOperatorForBatches();

        assertEq(swapManager.getOperatorCount(), 4);
    }

    function testOperatorSelectionForBatch() public {
        // Create and finalize a batch
        bytes32 batchId = keccak256("batch1");
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = keccak256("intent1");
        bytes32 poolId = keccak256("pool1");

        bytes[] memory encryptedIntents = new bytes[](1);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000),
            uint256(block.timestamp + 1 hours)
        );

        bytes memory batchData = abi.encode(
            batchId,
            intentIds,
            poolId,
            address(mockHook),
            encryptedIntents
        );

        vm.prank(address(mockHook));
        swapManager.finalizeBatch(batchId, batchData);

        // Check that an operator was selected
        // With 3 operators registered, at least one should be selected
        bool hasSelectedOperator = swapManager.isOperatorSelectedForBatch(batchId, operator1) ||
                                   swapManager.isOperatorSelectedForBatch(batchId, operator2) ||
                                   swapManager.isOperatorSelectedForBatch(batchId, operator3);

        assertTrue(hasSelectedOperator, "No operator was selected for batch");
    }

    function testHookAuthorization() public {
        address newHook = address(0x200);

        // Authorize new hook
        vm.prank(owner);
        swapManager.authorizeHook(newHook);

        // Should be able to finalize batch
        bytes32 batchId = keccak256("batch1");
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = keccak256("intent1");
        bytes32 poolId = keccak256("pool1");

        bytes[] memory encryptedIntents = new bytes[](1);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000),
            uint256(block.timestamp + 1 hours)
        );

        bytes memory batchData = abi.encode(
            batchId,
            intentIds,
            poolId,
            newHook,
            encryptedIntents
        );

        vm.prank(newHook);
        swapManager.finalizeBatch(batchId, batchData);

        // Should succeed
        ISwapManager.Batch memory batch = swapManager.getBatch(batchId);
        assertEq(batch.hook, newHook);
    }

    function testHookRevocation() public {
        // Revoke mockHook
        vm.prank(owner);
        swapManager.revokeHook(address(mockHook));

        // Should not be able to finalize batch
        bytes32 batchId = keccak256("batch1");
        bytes memory batchData = "";

        vm.prank(address(mockHook));
        vm.expectRevert("Unauthorized hook");
        swapManager.finalizeBatch(batchId, batchData);
    }

    function testBatchIdMismatch() public {
        bytes32 batchId = keccak256("batch1");
        bytes32 wrongBatchId = keccak256("batch2");
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = keccak256("intent1");
        bytes32 poolId = keccak256("pool1");

        bytes[] memory encryptedIntents = new bytes[](1);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000),
            uint256(block.timestamp + 1 hours)
        );

        // Encode with wrong batch ID
        bytes memory batchData = abi.encode(
            wrongBatchId,  // Wrong ID
            intentIds,
            poolId,
            address(mockHook),
            encryptedIntents
        );

        vm.prank(address(mockHook));
        vm.expectRevert("Batch ID mismatch");
        swapManager.finalizeBatch(batchId, batchData);
    }

    function testHookAddressMismatch() public {
        bytes32 batchId = keccak256("batch1");
        bytes32[] memory intentIds = new bytes32[](1);
        intentIds[0] = keccak256("intent1");
        bytes32 poolId = keccak256("pool1");

        bytes[] memory encryptedIntents = new bytes[](1);
        encryptedIntents[0] = abi.encode(
            intentIds[0],
            user1,
            tokenA,
            tokenB,
            uint256(1000),
            uint256(block.timestamp + 1 hours)
        );

        // Encode with wrong hook address
        bytes memory batchData = abi.encode(
            batchId,
            intentIds,
            poolId,
            address(0x999),  // Wrong hook address
            encryptedIntents
        );

        vm.prank(address(mockHook));
        vm.expectRevert("Hook address mismatch");
        swapManager.finalizeBatch(batchId, batchData);
    }

    // Note: submitBatchSettlement tests are skipped due to Solidity struct compatibility issues
    // The function uses IUniversalPrivacyHook structs which cannot be directly instantiated
    // in tests. This would require either:
    // 1. Exporting the interface structs to ISwapManager
    // 2. Using low-level calls with manual ABI encoding
    // 3. Creating a test wrapper contract
    // For now, the function is covered by integration tests in the hook package

    function testSubmitUEI() public {
        bytes memory ctBlob = abi.encode(
            bytes32(uint256(1)), // encDecoder
            bytes32(uint256(2)), // encTarget
            bytes32(uint256(3)), // encSelector
            new bytes32[](0)     // encArgs (all as euint256)
        );
        uint256 deadline = block.timestamp + 1 hours;

        // Users submit directly (not hooks)
        vm.prank(user1);
        bytes32 intentId = swapManager.submitEncryptedUEI(ctBlob, "", deadline);

        // Verify intent was created
        assertTrue(intentId != bytes32(0));

        // Get the task
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        assertEq(task.submitter, user1);
        assertEq(task.deadline, deadline);
        assertEq(uint(task.status), uint(ISwapManager.UEIStatus.Pending));
    }

    // Test removed - submitEncryptedUEI is now public (users submit directly, not hooks)
    // Anyone can submit UEI, no authorization check needed

    // testSubmitUEIWithProof skipped - requires FHE.fromExternal which needs proper FHE setup
    // This would require deploying the full FHE precompile contracts
    // Covered by integration tests in operator package

    function testProcessUEI() public {
        // First submit a UEI (user submits directly)
        bytes memory ctBlob = abi.encode(
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            bytes32(uint256(3)),
            new bytes32[](0)  // encArgs (all as euint256)
        );
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(user1);
        bytes32 intentId = swapManager.submitEncryptedUEI(ctBlob, "", deadline);

        // Finalize the batch first to select operators
        vm.warp(block.timestamp + 11 minutes); // Past MAX_BATCH_IDLE
        swapManager.finalizeUEIBatch();

        // Get selected operators from the batch
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        ISwapManager.TradeBatch memory batch = swapManager.getTradeBatch(task.batchId);
        address selectedOp = batch.selectedOperators[0];

        // Find the private key for the selected operator
        uint256 operatorPk;
        if (selectedOp == operator1) operatorPk = 2;
        else if (selectedOp == operator2) operatorPk = 3;
        else if (selectedOp == operator3) operatorPk = 4;

        // Prepare process data
        address decoder = address(0x100);
        address target = address(0x200);
        bytes memory reconstructedData = "0x12345678";

        // Create operator signature from selected operator
        bytes32 dataHash = keccak256(abi.encode(intentId, decoder, target, reconstructedData));
        bytes32 ethSigned = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            dataHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, ethSigned);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);

        // Process UEI from the selected operator
        vm.prank(selectedOp);
        swapManager.processUEI(intentId, decoder, target, reconstructedData, signatures);

        // Verify execution
        ISwapManager.UEIExecution memory execution = swapManager.getUEIExecution(intentId);
        assertEq(execution.decoder, decoder);
        assertEq(execution.target, target);
        assertEq(execution.executor, selectedOp);
    }

    function testProcessUEIRevertsIfNotSelected() public {
        // Submit a UEI (user submits directly)
        bytes memory ctBlob = abi.encode(
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            bytes32(uint256(3)),
            new bytes32[](0)  // encArgs (all as euint256)
        );

        vm.prank(user1);
        bytes32 intentId = swapManager.submitEncryptedUEI(ctBlob, "", block.timestamp + 1 hours);

        // Finalize batch to select operators
        vm.warp(block.timestamp + 11 minutes);
        swapManager.finalizeUEIBatch();

        // Try to process from non-selected operator
        address notSelectedOperator = address(0x999);
        vm.prank(notSelectedOperator);
        vm.expectRevert("Operator must be the caller");
        swapManager.processUEI(intentId, address(0x100), address(0x200), "", new bytes[](0));
    }

    function testSubmitEncryptedUEIBatchCreatesSeparateTasks() public {
        bytes[] memory ctBlobs = new bytes[](2);
        ctBlobs[0] = abi.encode(
            bytes32(uint256(11)),
            bytes32(uint256(12)),
            bytes32(uint256(13)),
            new bytes32[](0)
        );
        ctBlobs[1] = abi.encode(
            bytes32(uint256(21)),
            bytes32(uint256(22)),
            bytes32(uint256(23)),
            new bytes32[](0)
        );

        bytes[] memory proofs = new bytes[](2);
        proofs[0] = "";
        proofs[1] = "";

        uint256[] memory deadlines = new uint256[](2);
        deadlines[0] = block.timestamp + 30 minutes;
        deadlines[1] = block.timestamp + 45 minutes;

        vm.prank(user1);
        bytes32[] memory intentIds = swapManager.submitEncryptedUEIBatch(ctBlobs, proofs, deadlines);

        assertEq(intentIds.length, 2);

        ISwapManager.UEITask memory task0 = swapManager.getUEITask(intentIds[0]);
        ISwapManager.UEITask memory task1 = swapManager.getUEITask(intentIds[1]);

        assertEq(task0.submitter, user1);
        assertEq(task1.submitter, user1);
        assertEq(task0.batchId, task1.batchId, "UEIs should share batch");

        ISwapManager.TradeBatch memory batch = swapManager.getTradeBatch(task0.batchId);
        assertEq(batch.intentIds.length, 2, "Batch should track both intents");
        assertEq(batch.intentIds[0], intentIds[0]);
        assertEq(batch.intentIds[1], intentIds[1]);
    }

    function testProcessUEIBatchAggregated() public {
        bytes[] memory ctBlobs = new bytes[](2);
        ctBlobs[0] = abi.encode(
            bytes32(uint256(31)),
            bytes32(uint256(32)),
            bytes32(uint256(33)),
            new bytes32[](0)
        );
        ctBlobs[1] = abi.encode(
            bytes32(uint256(41)),
            bytes32(uint256(42)),
            bytes32(uint256(43)),
            new bytes32[](0)
        );

        bytes[] memory proofs = new bytes[](2);
        proofs[0] = "";
        proofs[1] = "";

        uint256[] memory deadlines = new uint256[](2);
        deadlines[0] = block.timestamp + 30 minutes;
        deadlines[1] = block.timestamp + 45 minutes;

        vm.prank(user1);
        bytes32[] memory intentIds = swapManager.submitEncryptedUEIBatch(ctBlobs, proofs, deadlines);

        vm.warp(block.timestamp + 11 minutes);
        swapManager.finalizeUEIBatch();

        ISwapManager.UEITask memory task = swapManager.getUEITask(intentIds[0]);
        ISwapManager.TradeBatch memory batch = swapManager.getTradeBatch(task.batchId);
        address selectedOp = batch.selectedOperators[0];

        uint256 operatorPk;
        if (selectedOp == operator1) operatorPk = 2;
        else if (selectedOp == operator2) operatorPk = 3;
        else operatorPk = 4;

        bytes32[] memory aggregatedIntentIds = intentIds;
        address[] memory decoders = new address[](0); // aggregated flow may omit per-step decoders
        address[] memory targets = new address[](2);
        targets[0] = address(0x300);
        targets[1] = address(0x301);

        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = hex"1111";
        calldatas[1] = hex"2222";

        bytes32 dataHash = keccak256(
            abi.encode(task.batchId, aggregatedIntentIds, decoders, targets, calldatas)
        );
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, ethSigned);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);

        vm.prank(selectedOp);
        swapManager.processUEI(aggregatedIntentIds, decoders, targets, calldatas, signatures);

        for (uint256 i = 0; i < aggregatedIntentIds.length; i++) {
            ISwapManager.UEITask memory processedTask = swapManager.getUEITask(aggregatedIntentIds[i]);
            assertEq(uint(processedTask.status), uint(ISwapManager.UEIStatus.Executed));

            ISwapManager.UEIExecution memory execution = swapManager.getUEIExecution(aggregatedIntentIds[i]);
            assertTrue(execution.success);
            assertEq(execution.executor, selectedOp);

            bytes[] memory decodedResults = abi.decode(execution.result, (bytes[]));
            assertEq(decodedResults.length, targets.length);
        }
    }
}
