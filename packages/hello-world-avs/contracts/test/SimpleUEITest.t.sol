// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "forge-std/Test.sol";
import "../src/MockPrivacyHook.sol";
import "../src/SimpleBoringVault.sol";
import "../src/ISwapManager.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20Token is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1000000 * 10 ** 18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SimpleUEITest is Test {
    MockPrivacyHook public mockHook;
    SimpleBoringVault public boringVault;

    // Mock SwapManager that just stores the UEI
    MockSwapManagerForUEI public swapManager;

    // Test tokens
    MockERC20Token public tokenA;
    MockERC20Token public tokenB;

    // Test addresses
    address public user = address(0x5);
    address public operator = address(0x6);

    // Mock Aave addresses for testing
    address public mockAavePool = address(0xAA7E);
    address public mockAaveDecoder = address(0xDEC0);

    function setUp() public {
        // Deploy mock SwapManager
        swapManager = new MockSwapManagerForUEI();

        // Deploy MockPrivacyHook and BoringVault
        mockHook = new MockPrivacyHook(address(swapManager));
        boringVault = new SimpleBoringVault(address(mockHook), address(swapManager));

        // Set up connections
        swapManager.authorizeHook(address(mockHook));
        swapManager.setBoringVault(payable(address(boringVault)));
        mockHook.setBoringVault(payable(address(boringVault)));

        // Deploy test tokens
        tokenA = new MockERC20Token("Token A", "TKNA");
        tokenB = new MockERC20Token("Token B", "TKNB");

        // Fund user and vault
        tokenA.mint(user, 10000 * 10 ** 18);
        tokenA.mint(address(boringVault), 10000 * 10 ** 18);
        tokenB.mint(address(boringVault), 10000 * 10 ** 18);
    }

    function testSubmitUEI() public {
        vm.startPrank(user);

        // Simulate encrypted values using encoding (in production these would be FHE ctHashes)
        uint256 ctDecoder = uint256(uint160(mockAaveDecoder));
        uint256 ctTarget = uint256(uint160(mockAavePool));
        uint32 ctSelector = uint32(bytes4(keccak256("supply(address,uint256,address,uint16)")));

        // Argument types (plaintext for PoC)
        uint8[] memory argTypes = new uint8[](4);
        argTypes[0] = 0; // ADDR type
        argTypes[1] = 1; // U256 type
        argTypes[2] = 0; // ADDR type
        argTypes[3] = 2; // U16 type

        // Simulate encrypted arguments
        uint256[] memory ctArgs = new uint256[](4);
        ctArgs[0] = uint256(uint160(address(tokenA)));
        ctArgs[1] = uint256(1000 * 10 ** 18);
        ctArgs[2] = uint256(uint160(address(boringVault)));
        ctArgs[3] = uint256(0);

        // Pack into blob
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

        // Verify UEI was created
        (address submitter, uint256 submittedDeadline, ) = swapManager.getUEI(intentId);
        assertEq(submitter, address(mockHook));
        assertEq(submittedDeadline, deadline);

        vm.stopPrank();
    }

    function testProcessUEI() public {
        vm.startPrank(user);

        // Submit a UEI first
        uint256 ctDecoder = uint256(uint160(mockAaveDecoder));
        uint256 ctTarget = uint256(uint160(mockAavePool));
        uint32 ctSelector = uint32(bytes4(keccak256("supply(address,uint256,address,uint16)")));

        uint8[] memory argTypes = new uint8[](4);
        argTypes[0] = 0;
        argTypes[1] = 1;
        argTypes[2] = 0;
        argTypes[3] = 2;

        uint256[] memory ctArgs = new uint256[](4);
        ctArgs[0] = uint256(uint160(address(tokenA)));
        ctArgs[1] = uint256(1000 * 10 ** 18);
        ctArgs[2] = uint256(uint160(address(boringVault)));
        ctArgs[3] = uint256(0);

        bytes memory ctBlob = abi.encode(ctDecoder, ctTarget, ctSelector, argTypes, ctArgs);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = mockHook.submitUEIBlob(ctBlob, deadline);

        vm.stopPrank();

        // Process as operator
        vm.startPrank(operator);

        // Simulate the decrypted data
        bytes memory reconstructedData = abi.encodeWithSelector(
            bytes4(keccak256("supply(address,uint256,address,uint16)")),
            address(tokenA),
            uint256(1000 * 10 ** 18),
            address(boringVault),
            uint16(0)
        );

        // Process the UEI
        swapManager.processUEI(
            intentId,
            mockAaveDecoder,
            mockAavePool,
            reconstructedData
        );

        // Verify it was processed
        assertTrue(swapManager.isProcessed(intentId));

        vm.stopPrank();
    }
}

// Simplified mock SwapManager for testing
contract MockSwapManagerForUEI is ISwapManager {
    mapping(address => bool) public authorizedHooks;
    address payable public boringVault;
    mapping(bytes32 => UEIData) public ueiData;
    mapping(bytes32 => bool) public isProcessed;

    struct UEIData {
        address submitter;
        bytes ctBlob;
        uint256 deadline;
    }

    modifier onlyAuthorizedHook() {
        require(authorizedHooks[msg.sender], "Unauthorized hook");
        _;
    }

    function authorizeHook(address hook) external {
        authorizedHooks[hook] = true;
    }

    function setBoringVault(address payable _vault) external {
        boringVault = _vault;
    }

    function submitUEI(
        bytes calldata ctBlob,
        uint256 deadline
    ) external onlyAuthorizedHook returns (bytes32 intentId) {
        intentId = keccak256(abi.encode(msg.sender, ctBlob, deadline, block.number));

        ueiData[intentId] = UEIData({
            submitter: msg.sender,
            ctBlob: ctBlob,
            deadline: deadline
        });

        emit UEISubmitted(intentId, msg.sender, ctBlob, deadline, new address[](0));
        return intentId;
    }

    function processUEI(
        bytes32 intentId,
        address decoder,
        address target,
        bytes calldata reconstructedData
    ) external {
        require(ueiData[intentId].submitter != address(0), "UEI does not exist");
        require(block.timestamp <= ueiData[intentId].deadline, "UEI expired");

        isProcessed[intentId] = true;

        emit UEIProcessed(intentId, true, reconstructedData);
    }

    function getUEI(bytes32 intentId) external view returns (address, uint256, bytes memory) {
        return (ueiData[intentId].submitter, ueiData[intentId].deadline, ueiData[intentId].ctBlob);
    }

    // Implement required interface functions (stubs)
    function latestTaskNum() external view returns (uint32) { return 0; }
    function allTaskHashes(uint32) external view returns (bytes32) { return bytes32(0); }
    function allTaskResponses(address, uint32) external view returns (bytes memory) { return ""; }
    function getTask(uint32) external view returns (SwapTask memory) {
        SwapTask memory task;
        return task;
    }
    function createNewSwapTask(address, address, address, bytes calldata, uint64) external returns (SwapTask memory) {
        SwapTask memory task;
        return task;
    }
    function respondToSwapTask(SwapTask calldata, uint32, uint256, bytes calldata) external {}
    function slashOperator(SwapTask calldata, uint32, address) external {}
    function createNewTask(string memory) external returns (Task memory) {
        Task memory task;
        return task;
    }
    function respondToTask(Task calldata, uint32, bytes calldata) external {}
    function slashOperator(Task calldata, uint32, address) external {}
    function finalizeBatch(bytes32, bytes calldata) external {}
    function submitBatchSettlement(BatchSettlement calldata, bytes[] calldata) external {}
    function getBatch(bytes32) external view returns (Batch memory) {
        Batch memory batch;
        return batch;
    }
    function getOperatorCount() external view returns (uint256) { return 0; }
    function isOperatorSelectedForBatch(bytes32, address) external view returns (bool) { return false; }
    function isOperatorRegistered(address) external view returns (bool) { return false; }
    function registerOperatorForBatches() external {}
    function processUEI(bytes32, address, address, bytes calldata, bytes[] calldata) external {}
    function getUEITask(bytes32) external view returns (UEITask memory) {
        UEITask memory task;
        return task;
    }
    function getUEIExecution(bytes32) external view returns (UEIExecution memory) {
        UEIExecution memory execution;
        return execution;
    }
}