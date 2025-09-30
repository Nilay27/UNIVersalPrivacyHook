// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.12;

import {Test} from "forge-std/Test.sol";
import {SwapManager} from "../src/SwapManager.sol";
import {ISwapManager} from "../src/ISwapManager.sol";
import {MockPrivacyHook} from "../src/MockPrivacyHook.sol";

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

contract SwapManagerBatchTest is Test {
    SwapManager public swapManager;
    MockPrivacyHook public mockHook;

    address owner = address(0x1);
    // Use vm.addr to get actual addresses from private keys
    address operator1 = vm.addr(2); // Private key 2
    address operator2 = vm.addr(3); // Private key 3
    address operator3 = vm.addr(4); // Private key 4
    address user1 = address(0x5);
    address tokenA = address(0x10);
    address tokenB = address(0x11);

    function setUp() public {
        // Mock FHE precompile addresses to prevent "call to non-contract" errors
        // Deploy mock bytecode at common FHE-related addresses
        vm.etch(address(0x000000000000000000000000000000000000005d), hex"00");
        vm.etch(address(0x687820221192C5B662b25367F70076A37bc79b6c), hex"00");  // The failing address
        vm.etch(address(0x848B0066793BcC60346Da1F49049357399B8D595), hex"00");  // Coprocessor

        // Deploy SwapManager with mock addresses
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
            new uint8[](0),      // argTypes
            new bytes32[](0)     // encArgs
        );
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(address(mockHook));
        bytes32 intentId = swapManager.submitUEI(ctBlob, deadline);

        // Verify intent was created
        assertTrue(intentId != bytes32(0));

        // Get the task
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        assertEq(task.submitter, address(mockHook));
        assertEq(task.deadline, deadline);
        assertEq(uint(task.status), uint(ISwapManager.UEIStatus.Pending));
    }

    function testSubmitUEIRevertsIfNotAuthorizedHook() public {
        bytes memory ctBlob = "";
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(user1); // Not authorized
        vm.expectRevert("Unauthorized hook");
        swapManager.submitUEI(ctBlob, deadline);
    }

    // testSubmitUEIWithProof skipped - requires FHE.fromExternal which needs proper FHE setup
    // This would require deploying the full FHE precompile contracts
    // Covered by integration tests in operator package

    function testProcessUEI() public {
        // First submit a UEI
        bytes memory ctBlob = abi.encode(
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            bytes32(uint256(3)),
            new uint8[](0),
            new bytes32[](0)
        );
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(address(mockHook));
        bytes32 intentId = swapManager.submitUEI(ctBlob, deadline);

        // Get selected operators
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        address selectedOp = task.selectedOperators[0];

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
        // Submit a UEI
        bytes memory ctBlob = abi.encode(
            bytes32(uint256(1)),
            bytes32(uint256(2)),
            bytes32(uint256(3)),
            new uint8[](0),
            new bytes32[](0)
        );

        vm.prank(address(mockHook));
        bytes32 intentId = swapManager.submitUEI(ctBlob, block.timestamp + 1 hours);

        // Try to process from non-selected operator
        address notSelectedOperator = address(0x999);
        vm.prank(notSelectedOperator);
        vm.expectRevert("Operator must be the caller");
        swapManager.processUEI(intentId, address(0x100), address(0x200), "", new bytes[](0));
    }
}