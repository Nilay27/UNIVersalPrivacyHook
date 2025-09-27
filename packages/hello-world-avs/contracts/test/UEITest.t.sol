// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "forge-std/Test.sol";
import "../src/SwapManager.sol";
import "../src/MockPrivacyHook.sol";
import "../src/SimpleBoringVault.sol";
import "../src/ISwapManager.sol";

// EigenLayer imports are handled by SwapManager

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1000000 * 10 ** 18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract UEITest is Test {
    SwapManager public swapManager;
    MockPrivacyHook public mockHook;
    SimpleBoringVault public boringVault;

    // Mock contracts
    address public avsDirectory;
    address public stakeRegistry;
    address public rewardsCoordinator;
    address public delegationManager;
    address public allocationManager;

    // Test tokens
    MockERC20 public tokenA;
    MockERC20 public tokenB;

    // Test addresses
    address public owner = address(0x1);
    address public operator1 = address(0x2);
    address public operator2 = address(0x3);
    address public operator3 = address(0x4);
    address public user = address(0x5);

    // Mock Aave addresses for testing
    address public mockAavePool = address(0xAA7E);
    address public mockAaveDecoder = address(0xDEC0);

    function setUp() public {
        vm.startPrank(owner);

        // Deploy mock EigenLayer contracts
        avsDirectory = address(new MockContract());
        stakeRegistry = address(new MockStakeRegistry());
        rewardsCoordinator = address(new MockContract());
        delegationManager = address(new MockContract());
        allocationManager = address(new MockContract());

        // Deploy SwapManager AVS
        swapManager = new SwapManager(
            avsDirectory,
            stakeRegistry,
            rewardsCoordinator,
            delegationManager,
            allocationManager,
            100 // max response blocks
        );

        swapManager.initialize(owner, owner);

        // Deploy MockPrivacyHook and BoringVault
        mockHook = new MockPrivacyHook(address(swapManager));
        boringVault = new SimpleBoringVault(address(mockHook), address(swapManager));

        // Set up connections
        swapManager.authorizeHook(address(mockHook));
        swapManager.setBoringVault(payable(address(boringVault)));
        mockHook.setBoringVault(payable(address(boringVault)));

        // Deploy test tokens
        tokenA = new MockERC20("Token A", "TKNA");
        tokenB = new MockERC20("Token B", "TKNB");

        // Register operators
        MockStakeRegistry(stakeRegistry).addOperator(operator1);
        MockStakeRegistry(stakeRegistry).addOperator(operator2);
        MockStakeRegistry(stakeRegistry).addOperator(operator3);

        vm.stopPrank();

        // Register operators with SwapManager
        vm.prank(operator1);
        swapManager.registerOperatorForBatches();

        vm.prank(operator2);
        swapManager.registerOperatorForBatches();

        vm.prank(operator3);
        swapManager.registerOperatorForBatches();

        // Fund user and vault
        tokenA.mint(user, 10000 * 10 ** 18);
        tokenA.mint(address(boringVault), 10000 * 10 ** 18);
        tokenB.mint(address(boringVault), 10000 * 10 ** 18);
    }

    function testSubmitUEI() public {
        vm.startPrank(user);

        // Simulate encrypted values using encoding (in production these would be FHE ctHashes)
        // The operator will use real CoFHE.js encryption/decryption
        uint256 ctDecoder = uint256(uint160(mockAaveDecoder));
        uint256 ctTarget = uint256(uint160(mockAavePool));
        uint32 ctSelector = uint32(bytes4(keccak256("supply(address,uint256,address,uint16)")));

        // Argument types (plaintext for PoC)
        uint8[] memory argTypes = new uint8[](4);
        argTypes[0] = 0; // ADDR type
        argTypes[1] = 1; // U256 type
        argTypes[2] = 0; // ADDR type
        argTypes[3] = 2; // U16 type

        // Simulate encrypted arguments (in production these would be FHE ctHashes)
        uint256[] memory ctArgs = new uint256[](4);
        ctArgs[0] = uint256(uint160(address(tokenA))); // Simulated Enc(tokenA)
        ctArgs[1] = uint256(1000 * 10 ** 18); // Simulated Enc(amount)
        ctArgs[2] = uint256(uint160(address(boringVault))); // Simulated Enc(boringVault)
        ctArgs[3] = uint256(0); // Simulated Enc(referralCode)

        // Pack into blob as the AVS expects
        bytes memory ctBlob = abi.encode(
            ctDecoder,
            ctTarget,
            ctSelector,
            argTypes,
            ctArgs
        );

        uint256 deadline = block.timestamp + 1 hours;

        // Submit UEI blob
        bytes32 intentId = mockHook.submitUEIBlob(ctBlob, deadline);

        // Verify UEI was created in SwapManager
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        assertEq(task.submitter, address(mockHook));
        assertEq(task.deadline, deadline);
        assertTrue(task.status == ISwapManager.UEIStatus.Pending);
        assertGt(task.selectedOperators.length, 0, "Should have selected operators");

        vm.stopPrank();
    }

    function testSubmitAndProcessUEI() public {
        vm.startPrank(user);

        // Create blob with simulated encrypted data
        uint256 ctDecoder = uint256(uint160(mockAaveDecoder));
        uint256 ctTarget = uint256(uint160(mockAavePool));
        uint32 ctSelector = uint32(bytes4(keccak256("supply(address,uint256,address,uint16)")));

        uint8[] memory argTypes = new uint8[](4);
        argTypes[0] = 0; // ADDR
        argTypes[1] = 1; // U256
        argTypes[2] = 0; // ADDR
        argTypes[3] = 2; // U16

        uint256[] memory ctArgs = new uint256[](4);
        ctArgs[0] = uint256(uint160(address(tokenA)));
        ctArgs[1] = uint256(1000 * 10 ** 18);
        ctArgs[2] = uint256(uint160(address(boringVault)));
        ctArgs[3] = uint256(0);

        bytes memory ctBlob = abi.encode(
            ctDecoder,
            ctTarget,
            ctSelector,
            argTypes,
            ctArgs
        );

        uint256 deadline = block.timestamp + 1 hours;

        // Submit UEI blob
        bytes32 intentId = mockHook.submitUEIBlob(ctBlob, deadline);

        vm.stopPrank();

        // Get the task to find selected operators
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        address selectedOperator = task.selectedOperators[0];

        // Process UEI as selected operator
        vm.startPrank(selectedOperator);

        // Create reconstructed calldata (what operator would create after decryption)
        bytes memory reconstructedData = abi.encodeWithSelector(
            bytes4(keccak256("supply(address,uint256,address,uint16)")),
            address(tokenA),
            uint256(1000 * 10 ** 18),
            address(boringVault),
            uint16(0)
        );

        // Create operator signatures (at least MIN_ATTESTATIONS required)
        bytes[] memory signatures = new bytes[](3);

        // Sign the data hash
        bytes32 dataHash = keccak256(abi.encode(intentId, mockAaveDecoder, mockAavePool, reconstructedData));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash));

        // Create mock signatures (in real scenario, operators would sign)
        for (uint i = 0; i < 3; i++) {
            if (i < task.selectedOperators.length) {
                // Mock signature - in real test would use vm.sign
                signatures[i] = abi.encodePacked(ethSignedHash, task.selectedOperators[i]);
            }
        }

        // Process the UEI
        swapManager.processUEI(
            intentId,
            mockAaveDecoder,
            mockAavePool,
            reconstructedData,
            signatures
        );

        // Verify UEI was processed
        ISwapManager.UEITask memory processedTask = swapManager.getUEITask(intentId);
        assertTrue(
            processedTask.status == ISwapManager.UEIStatus.Executed ||
            processedTask.status == ISwapManager.UEIStatus.Processing,
            "UEI should be executed or processing"
        );

        vm.stopPrank();
    }

    function testUEIWithBoringVaultExecution() public {
        // Deploy a mock target contract
        MockTarget mockTarget = new MockTarget();

        // Fund the vault
        vm.deal(address(boringVault), 1 ether);

        vm.startPrank(user);

        // Create UEI for a simple function call (simulated encryption)
        uint256 ctDecoder = uint256(0); // no decoder needed for this test
        uint256 ctTarget = uint256(uint160(address(mockTarget)));
        uint32 ctSelector = uint32(bytes4(keccak256("doSomething(uint256)")));

        uint8[] memory argTypes = new uint8[](1);
        argTypes[0] = 1; // U256

        uint256[] memory ctArgs = new uint256[](1);
        ctArgs[0] = uint256(42);

        bytes memory ctBlob = abi.encode(
            ctDecoder,
            ctTarget,
            ctSelector,
            argTypes,
            ctArgs
        );

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = mockHook.submitUEIBlob(ctBlob, deadline);

        vm.stopPrank();

        // Get selected operator
        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        address selectedOperator = task.selectedOperators[0];

        // Process as operator
        vm.startPrank(selectedOperator);

        bytes memory reconstructedData = abi.encodeWithSelector(
            bytes4(keccak256("doSomething(uint256)")),
            uint256(42)
        );

        bytes[] memory signatures = new bytes[](3);
        // Mock signatures (simplified for test)
        for (uint i = 0; i < 3; i++) {
            signatures[i] = abi.encodePacked(bytes32(0), bytes32(0));
        }

        swapManager.processUEI(
            intentId,
            address(0),
            address(mockTarget),
            reconstructedData,
            signatures
        );

        // Check that the target was called
        assertEq(mockTarget.lastValue(), 42, "Target should have been called with correct value");

        vm.stopPrank();
    }

    function testUEIExpiration() public {
        vm.startPrank(user);

        // Create a minimal blob with simulated encrypted data
        bytes memory ctBlob = abi.encode(
            uint256(1), // ctDecoder
            uint256(2), // ctTarget
            uint32(3),  // ctSelector
            new uint8[](0), // argTypes
            new uint256[](0) // ctArgs
        );
        uint256 deadline = block.timestamp + 100;

        bytes32 intentId = mockHook.submitUEIBlob(ctBlob, deadline);

        vm.stopPrank();

        // Fast forward past deadline
        vm.warp(block.timestamp + 101);

        ISwapManager.UEITask memory task = swapManager.getUEITask(intentId);
        address selectedOperator = task.selectedOperators[0];

        vm.startPrank(selectedOperator);

        bytes[] memory signatures = new bytes[](3);

        // Should revert due to expiration
        vm.expectRevert("UEI expired");
        swapManager.processUEI(
            intentId,
            address(0),
            address(0),
            "",
            signatures
        );

        vm.stopPrank();
    }
}

// Mock contracts for testing
contract MockContract {
    fallback() external payable {}
    receive() external payable {}
}

contract MockStakeRegistry {
    mapping(address => bool) public operatorRegistered;
    address[] public operators;

    function addOperator(address operator) external {
        operatorRegistered[operator] = true;
        operators.push(operator);
    }

    function getOperatorList() external view returns (address[] memory) {
        return operators;
    }
}

contract MockTarget {
    uint256 public lastValue;

    function doSomething(uint256 value) external {
        lastValue = value;
    }
}