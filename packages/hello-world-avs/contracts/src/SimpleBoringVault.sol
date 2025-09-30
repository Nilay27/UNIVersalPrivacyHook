// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title SimpleBoringVault
 * @notice A simplified vault that holds strategy capital and executes trades
 * @dev 80% of liquidity from the hook will be managed here
 */
contract SimpleBoringVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Address for address;

    // ========================================= STATE =========================================

    /**
     * @notice The UniversalPrivacyHook that can deposit funds
     */
    address public immutable hook;

    /**
     * @notice The SwapManager AVS that can execute strategies
     */
    address public immutable tradeManager;

    /**
     * @notice Track token balances deposited from hook
     */
    mapping(address => uint256) public tokenBalances;

    /**
     * @notice Track which addresses are authorized to execute
     */
    mapping(address => bool) public authorizedExecutors;

    // ========================================= EVENTS =========================================

    event Deposited(address indexed token, uint256 amount, address indexed from);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event StrategyExecuted(address indexed target, bytes data, uint256 value, bytes result);
    event ExecutorUpdated(address indexed executor, bool authorized);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    // ========================================= ERRORS =========================================

    error Unauthorized();
    error InsufficientBalance();
    error ExecutionFailed();
    error ZeroAddress();
    error ZeroAmount();

    // ========================================= MODIFIERS =========================================

    modifier onlyHook() {
        if (msg.sender != hook) revert Unauthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != hook && msg.sender != tradeManager && !authorizedExecutors[msg.sender]) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyTradeManager() {
        if (msg.sender != tradeManager) revert Unauthorized();
        _;
    }

    // ========================================= CONSTRUCTOR =========================================

    constructor(address _hook, address _tradeManager) {
        if (_hook == address(0)) revert ZeroAddress();
        if (_tradeManager == address(0)) revert ZeroAddress();

        hook = _hook;
        tradeManager = _tradeManager;
    }

    // ========================================= EXTERNAL FUNCTIONS =========================================

    /**
     * @notice Deposit tokens from the hook (80% of liquidity)
     * @param token The token to deposit
     * @param amount The amount to deposit
     */
    function deposit(address token, uint256 amount) external onlyHook nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Transfer tokens from hook to this vault
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Update balance tracking
        tokenBalances[token] += amount;

        emit Deposited(token, amount, msg.sender);
    }

    /**
     * @notice Execute a strategy call through the vault
     * @param target The target contract to call
     * @param data The calldata for the call
     * @param value The ETH value to send with the call
     * @return result The return data from the call
     */
    function execute(
        address target,
        bytes calldata data,
        uint256 value
    ) external onlyAuthorized nonReentrant returns (bytes memory result) {
        // Make the external call
        result = target.functionCallWithValue(data, value);

        emit StrategyExecuted(target, data, value, result);
    }

    /**
     * @notice Execute multiple strategy calls in sequence
     * @param targets Array of target contracts
     * @param dataArray Array of calldata
     * @param values Array of ETH values
     * @return results Array of return data
     */
    function batchExecute(
        address[] calldata targets,
        bytes[] calldata dataArray,
        uint256[] calldata values
    ) external onlyAuthorized nonReentrant returns (bytes[] memory results) {
        uint256 length = targets.length;
        require(length == dataArray.length && length == values.length, "Length mismatch");

        results = new bytes[](length);

        for (uint256 i = 0; i < length; i++) {
            results[i] = targets[i].functionCallWithValue(dataArray[i], values[i]);
            emit StrategyExecuted(targets[i], dataArray[i], values[i], results[i]);
        }
    }

    /**
     * @notice Withdraw tokens back to the hook
     * @param token The token to withdraw
     * @param amount The amount to withdraw
     * @param to The recipient address
     */
    function withdraw(
        address token,
        uint256 amount,
        address to
    ) external onlyHook nonReentrant {
        if (tokenBalances[token] < amount) revert InsufficientBalance();

        // Update balance tracking
        tokenBalances[token] -= amount;

        // Transfer tokens
        IERC20(token).safeTransfer(to, amount);

        emit Withdrawn(token, amount, to);
    }

    /**
     * @notice Emergency withdraw function for trade manager
     * @dev Only callable by trade manager in case of emergency
     */
    function emergencyWithdraw(
        address token,
        uint256 amount,
        address to
    ) external onlyTradeManager nonReentrant {
        if (tokenBalances[token] < amount) revert InsufficientBalance();

        // Update balance tracking
        tokenBalances[token] -= amount;

        // Transfer tokens
        IERC20(token).safeTransfer(to, amount);

        emit EmergencyWithdraw(token, amount, to);
    }

    /**
     * @notice Update authorized executor status
     * @param executor The executor address
     * @param authorized Whether the executor is authorized
     */
    function setExecutor(address executor, bool authorized) external onlyTradeManager {
        authorizedExecutors[executor] = authorized;
        emit ExecutorUpdated(executor, authorized);
    }

    /**
     * @notice Get the current balance of a token in the vault
     * @param token The token address
     * @return The balance amount
     */
    function getBalance(address token) external view returns (uint256) {
        return tokenBalances[token];
    }

    /**
     * @notice Check if an address is authorized to execute
     * @param executor The address to check
     * @return Whether the address is authorized
     */
    function isAuthorized(address executor) external view returns (bool) {
        return executor == hook || executor == tradeManager || authorizedExecutors[executor];
    }

    /**
     * @notice Approve a token for spending by a protocol
     * @dev This is needed for the vault to interact with DeFi protocols
     * @param token The token to approve
     * @param spender The spender address
     * @param amount The amount to approve
     */
    function approveToken(
        address token,
        address spender,
        uint256 amount
    ) external onlyAuthorized {
        IERC20(token).safeApprove(spender, 0); // Reset to 0 first
        IERC20(token).safeApprove(spender, amount);
    }

    /**
     * @notice Receive ETH
     */
    receive() external payable {}

    /**
     * @notice Fallback function
     */
    fallback() external payable {}
}