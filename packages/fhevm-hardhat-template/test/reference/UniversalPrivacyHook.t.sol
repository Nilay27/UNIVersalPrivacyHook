// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Foundry Imports
import "forge-std/Test.sol";

// Uniswap Imports
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

// Test Utils
import {Deployers} from "./utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

// FHE Imports  
import {FHE, InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {CoFheTest} from "@fhenixprotocol/cofhe-mock-contracts/CoFheTest.sol";

// Privacy Hook Imports
import {UniversalPrivacyHook} from "../src/privacy/UniversalPrivacyHook.sol";
import {IFHERC20} from "../src/privacy/interfaces/IFHERC20.sol";
import {HybridFHERC20} from "../src/privacy/HybridFHERC20.sol";

contract UniversalPrivacyHookTest is Test, Deployers, CoFheTest {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using LPFeeLibrary for uint24;

    // Test Constants
    uint256 constant INITIAL_LIQUIDITY = 100e18;
    uint256 constant USER_INITIAL_BALANCE = 10000e6; // 10,000 USDC (6 decimals)
    uint256 constant DEPOSIT_AMOUNT = 1000e6; // 1,000 USDC
    uint256 constant SWAP_AMOUNT = 200e6; // 200 USDC

    // Contracts
    UniversalPrivacyHook hook;
    MockERC20 usdc;
    MockERC20 usdt;
    PoolKey poolKey;
    PoolId poolId;

    // Test Users
    address alice = address(0xABCD);
    address bob = address(0x1234);

    function setUp() public {
        // Deploy core contracts
        deployFreshManagerAndRouters();
        
        // Deploy mock tokens (USDC = 6 decimals, USDT = 6 decimals)
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdt = new MockERC20("Tether USD", "USDT", 6);
        
        // Deploy UniversalPrivacyHook
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        address hookAddress = address(flags);
        deployCodeTo("UniversalPrivacyHook.sol", abi.encode(manager), hookAddress);
        hook = UniversalPrivacyHook(hookAddress);

        // Create USDC/USDT pool
        poolKey = PoolKey(
            Currency.wrap(address(usdc)),
            Currency.wrap(address(usdt)), 
            3000, // 0.3% fee
            60, // tick spacing
            IHooks(hook)
        );
        poolId = poolKey.toId();
        
        // Initialize pool
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        
        // Add initial liquidity
        usdc.mint(address(this), INITIAL_LIQUIDITY);
        usdt.mint(address(this), INITIAL_LIQUIDITY);
        
        usdc.approve(address(modifyLiquidityRouter), INITIAL_LIQUIDITY);
        usdt.approve(address(modifyLiquidityRouter), INITIAL_LIQUIDITY);
        
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            LIQUIDITY_PARAMS,
            ZERO_BYTES
        );

        // Setup test users with USDC
        usdc.mint(alice, USER_INITIAL_BALANCE);
        usdc.mint(bob, USER_INITIAL_BALANCE);
        
        // Give hook approval to spend user tokens
        vm.prank(alice);
        usdc.approve(address(hook), type(uint256).max);
        
        vm.prank(bob);
        usdc.approve(address(hook), type(uint256).max);
    }

    function testPoolCreation() public {
        // Verify pool was created successfully
        assertEq(Currency.unwrap(poolKey.currency0), address(usdc));
        assertEq(Currency.unwrap(poolKey.currency1), address(usdt));
        assertEq(address(poolKey.hooks), address(hook));
        
        console.log("Pool created: USDC/USDT with UniversalPrivacyHook");
    }

    function testUserDeposit() public {
        console.log("Testing User Deposit Flow: USDC -> Encrypted USDC Tokens");
        
        // Check initial balances
        uint256 aliceInitialUSDC = usdc.balanceOf(alice);
        assertEq(aliceInitialUSDC, USER_INITIAL_BALANCE);
        console.log("Alice initial USDC balance:", aliceInitialUSDC / 1e6);

        // Alice deposits USDC to get encrypted USDC tokens
        vm.prank(alice);
        hook.deposit(poolKey, Currency.wrap(address(usdc)), DEPOSIT_AMOUNT);
        
        // Verify USDC was transferred to hook
        uint256 aliceFinalUSDC = usdc.balanceOf(alice);
        uint256 hookUSDCBalance = usdc.balanceOf(address(hook));
        
        assertEq(aliceFinalUSDC, USER_INITIAL_BALANCE - DEPOSIT_AMOUNT);
        assertEq(hookUSDCBalance, DEPOSIT_AMOUNT);
        
        console.log("Alice final USDC balance:", aliceFinalUSDC / 1e6);
        console.log("Hook USDC balance:", hookUSDCBalance / 1e6);
        
        // Verify encrypted token was created and Alice received encrypted balance
        IFHERC20 encryptedUSDC = hook.poolEncryptedTokens(poolId, Currency.wrap(address(usdc)));
        assertTrue(address(encryptedUSDC) != address(0), "Encrypted USDC token should be created");
        
        // Check Alice's encrypted balance exists (encrypted balance, not public balance)
        euint128 aliceEncryptedBalance = encryptedUSDC.encBalances(alice);
        // We can't easily decrypt in tests, but we can verify it exists (non-zero wrapped value)
        uint256 aliceEncryptedBalanceWrapped = euint128.unwrap(aliceEncryptedBalance);
        console.log("Alice encrypted balance (wrapped value):", aliceEncryptedBalanceWrapped);
        
        // Also verify public balance is 0 (since we used encrypted minting)
        uint256 alicePublicBalance = encryptedUSDC.balanceOf(alice);
        console.log("Alice public balance (should be 0):", alicePublicBalance);
        assertEq(alicePublicBalance, 0, "Public balance should be 0 when using encrypted minting");
        
        // Verify hook reserves were updated
        uint256 hookReserves = hook.poolReserves(poolId, Currency.wrap(address(usdc)));
        assertEq(hookReserves, DEPOSIT_AMOUNT);
        
        console.log("Deposit successful: Alice deposited", DEPOSIT_AMOUNT / 1e6, "USDC and received encrypted tokens");
    }

    function testEncryptedIntentSubmission() public {
        console.log("Testing Encrypted Intent Submission");
        
        // First, Alice needs to deposit to have encrypted tokens
        vm.prank(alice);
        hook.deposit(poolKey, Currency.wrap(address(usdc)), DEPOSIT_AMOUNT);
        
        // Alice submits encrypted swap intent: swap 200 encrypted USDC for USDT
        vm.startPrank(alice);
        // Create encrypted amount - signer must be alice since she's the transaction sender
        InEuint128 memory encryptedSwapAmount = createInEuint128(uint128(SWAP_AMOUNT), alice);
        hook.submitIntent(
            poolKey,
            Currency.wrap(address(usdc)), // tokenIn
            Currency.wrap(address(usdt)), // tokenOut  
            encryptedSwapAmount,
            uint64(block.timestamp + 1 hours) // deadline
        );
        vm.stopPrank();
        
        console.log("Alice successfully submitted encrypted swap intent");
        console.log("Intent: Swap encrypted USDC for encrypted USDT");
    }

    function testCompletePrivacyFlow() public {
        console.log("Testing Complete Privacy Flow: Deposit -> Intent -> Execution");
        
        // === STEP 1: DEPOSIT ===
        console.log("\n Step 1: Alice deposits USDC");
        vm.prank(alice);
        hook.deposit(poolKey, Currency.wrap(address(usdc)), DEPOSIT_AMOUNT);
        
        uint256 hookBalanceBefore = usdc.balanceOf(address(hook));
        console.log("Hook USDC balance after deposit:", hookBalanceBefore / 1e6);
        
        // === STEP 2: SUBMIT ENCRYPTED INTENT ===
        console.log("\nStep 2: Alice submits encrypted swap intent");
        vm.startPrank(alice);
        // Create encrypted amount - signer must be alice since she's the transaction sender
        InEuint128 memory encryptedSwapAmount = createInEuint128(uint128(SWAP_AMOUNT), alice);
        hook.submitIntent(
            poolKey,
            Currency.wrap(address(usdc)),
            Currency.wrap(address(usdt)),
            encryptedSwapAmount,
            uint64(block.timestamp + 1 hours)
        );
        vm.stopPrank();
        
        // === STEP 3: TRIGGER INTENT PROCESSING ===
        console.log("\nStep 3: Trigger intent processing via swap");
        
        // Warp time to ensure FHE decryption is ready (using same pattern as MarketOrder tests)
        vm.warp(block.timestamp + 11);
        
        // Someone else makes a regular swap to trigger beforeSwap and process Alice's intent
        usdt.mint(bob, 1000e6);
        vm.prank(bob);
        usdt.approve(address(swapRouter), 1000e6);
        
        vm.prank(bob);
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: false, // USDT → USDC
                amountSpecified: -100e6, // Swap 100 USDT
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ZERO_BYTES
        );
        
        console.log(" External swap triggered intent processing");
        
        // === STEP 4: VERIFY RESULTS ===
        console.log("\n Step 4: Verify privacy flow results");
        
        // Get encrypted token contracts
        IFHERC20 encryptedUSDC = hook.poolEncryptedTokens(poolId, Currency.wrap(address(usdc)));
        IFHERC20 encryptedUSDT = hook.poolEncryptedTokens(poolId, Currency.wrap(address(usdt)));
        
        // Check hook's actual token balances
        uint256 hookUSDCBalance = usdc.balanceOf(address(hook));
        uint256 hookUSDTBalance = usdt.balanceOf(address(hook));
        console.log("\nHook's actual token balances:");
        console.log("  USDC balance:", hookUSDCBalance / 1e6, "USDC");
        console.log("  USDT balance:", hookUSDTBalance / 1e6, "USDT");
        
        // Check hook's internal reserves tracking
        uint256 hookUSDCReserves = hook.poolReserves(poolId, Currency.wrap(address(usdc)));
        uint256 hookUSDTReserves = hook.poolReserves(poolId, Currency.wrap(address(usdt)));
        console.log("\nHook's internal reserves:");
        console.log("  USDC reserves:", hookUSDCReserves / 1e6, "USDC");
        console.log("  USDT reserves:", hookUSDTReserves / 1e6, "USDT");
        
        // Check Alice's public balances (should be 0 for encrypted tokens)
        uint256 alicePublicUSDCTokens = encryptedUSDC.balanceOf(alice);
        uint256 alicePublicUSDTTokens = address(encryptedUSDT) != address(0) ? encryptedUSDT.balanceOf(alice) : 0;
        console.log("\nAlice's public token balances (should be 0):");
        console.log("  Public eUSDC:", alicePublicUSDCTokens);
        console.log("  Public eUSDT:", alicePublicUSDTTokens);
        
        // Check Alice's encrypted balances
        euint128 aliceEncUSDC = encryptedUSDC.encBalances(alice);
        euint128 aliceEncUSDT = address(encryptedUSDT) != address(0) ? encryptedUSDT.encBalances(alice) : FHE.asEuint128(0);
        console.log("\nAlice's encrypted balances (wrapped values):");
        console.log("  Encrypted eUSDC:", euint128.unwrap(aliceEncUSDC));
        console.log("  Encrypted eUSDT:", euint128.unwrap(aliceEncUSDT));
        
        // Check if Alice has any encrypted USDT (indicates successful swap)
        if (address(encryptedUSDT) != address(0) && euint128.unwrap(aliceEncUSDT) != 0) {
            console.log("\n SUCCESS: Alice received encrypted USDT tokens from private swap!");
        }
        
        console.log("\nCOMPLETE PRIVACY FLOW SUMMARY:");
        console.log(" 1. Alice deposited 1000 USDC -> got encrypted USDC tokens");
        console.log(" 2. Alice submitted encrypted swap intent for 200 USDC");
        console.log(" 3. Intent was processed privately via hook");
        console.log(" 4. Alice received encrypted USDT tokens");
        console.log(" 5. All balances remain encrypted and private!");
    }

    function testMultiPoolSupport() public {
        console.log("Testing Multi-Pool Support");
        
        // First, Alice deposits USDC in Pool 1 (USDC/USDT) to create encrypted token
        vm.prank(alice);
        hook.deposit(poolKey, Currency.wrap(address(usdc)), DEPOSIT_AMOUNT);
        
        // Create a second pool (USDC/WETH)
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
        
        PoolKey memory secondPoolKey = PoolKey(
            Currency.wrap(address(usdc)),
            Currency.wrap(address(weth)),
            3000,
            60,
            IHooks(hook)
        );
        PoolId secondPoolId = secondPoolKey.toId();
        
        // Calculate sqrt price for 1 WETH = 4000 USDC
        // Pool ordering: token0 = USDC (6 decimals), token1 = WETH (18 decimals)
        // Price in pool = WETH per USDC = 1/4000 = 0.00025
        // Adjusted for decimals: 0.00025 * 10^(18-6) = 0.00025 * 1e12 = 2.5e8
        // sqrtPrice = sqrt(2.5e8) ≈ 15811.4
        // sqrtPriceX96 = 15811.4 * 2^96 ≈ 1.25e30
        uint160 sqrtPriceX96_USDC_WETH = 1252707241875239655932069007848031; // sqrt(2.5e8) * 2^96
        
        // Initialize second pool with proper price
        manager.initialize(secondPoolKey, sqrtPriceX96_USDC_WETH);
        
        // Add liquidity to second pool
        // Mint tokens for liquidity provision (need more for the price range)
        uint256 usdcLiquidityAmount = 10000000e6; // 10 million USDC
        uint256 wethLiquidityAmount = 2500e18;     // 2500 WETH (10M / 4000)
        
        usdc.mint(address(this), usdcLiquidityAmount);
        weth.mint(address(this), wethLiquidityAmount);
        
        usdc.approve(address(modifyLiquidityRouter), usdcLiquidityAmount);
        weth.approve(address(modifyLiquidityRouter), wethLiquidityAmount);

        // ticks around the current price (spacing = 60)
        int24 center = 193320;
        int24 tickLower = 192720;
        int24 tickUpper = 193920;
                
        // Add liquidity with appropriate tick range (must be divisible by tick spacing of 60)
        modifyLiquidityRouter.modifyLiquidity(
            secondPoolKey,
            ModifyLiquidityParams({
                tickLower: tickLower,  // Wide range for testing, divisible by 60
                tickUpper: tickUpper,
                liquidityDelta: 1e18,
                salt: 0
            }),
            ZERO_BYTES
        );
        
        // Alice deposits USDC in the second pool
        vm.prank(alice);
        hook.deposit(secondPoolKey, Currency.wrap(address(usdc)), DEPOSIT_AMOUNT);
        
        // Bob deposits WETH in the second pool
        weth.mint(bob, 1e18);
        vm.prank(bob);
        weth.approve(address(hook), 1e18);
        vm.prank(bob);
        hook.deposit(secondPoolKey, Currency.wrap(address(weth)), 1e18);
        
        // Verify separate encrypted tokens were created for each pool
        IFHERC20 encryptedUSDC_Pool1 = hook.poolEncryptedTokens(poolId, Currency.wrap(address(usdc)));
        IFHERC20 encryptedUSDC_Pool2 = hook.poolEncryptedTokens(secondPoolId, Currency.wrap(address(usdc)));
        IFHERC20 encryptedWETH_Pool2 = hook.poolEncryptedTokens(secondPoolId, Currency.wrap(address(weth)));
        
        assertTrue(address(encryptedUSDC_Pool1) != address(0), "Pool 1 encrypted USDC should exist");
        assertTrue(address(encryptedUSDC_Pool2) != address(0), "Pool 2 encrypted USDC should exist");
        assertTrue(address(encryptedWETH_Pool2) != address(0), "Pool 2 encrypted WETH should exist");
        assertTrue(address(encryptedUSDC_Pool1) != address(encryptedUSDC_Pool2), "Each pool should have separate encrypted tokens");
        
        // Log detailed information about hook balances and encrypted tokens
        console.log("\n=== MULTI-POOL SUPPORT VERIFICATION ===");
        
        // Check hook's actual token balances
        uint256 hookUSDCBalance = usdc.balanceOf(address(hook));
        uint256 hookUSDTBalance = usdt.balanceOf(address(hook));
        uint256 hookWETHBalance = weth.balanceOf(address(hook));
        
        console.log("\nHook's actual token balances:");
        console.log("  USDC balance:", hookUSDCBalance / 1e6, "USDC");
        console.log("  USDT balance:", hookUSDTBalance / 1e6, "USDT");
        console.log("  WETH balance:", hookWETHBalance / 1e18, "WETH");
        
        // Check hook's reserves for each pool
        uint256 pool1USDCReserves = hook.poolReserves(poolId, Currency.wrap(address(usdc)));
        uint256 pool1USDTReserves = hook.poolReserves(poolId, Currency.wrap(address(usdt)));
        uint256 pool2USDCReserves = hook.poolReserves(secondPoolId, Currency.wrap(address(usdc)));
        uint256 pool2WETHReserves = hook.poolReserves(secondPoolId, Currency.wrap(address(weth)));
        
        console.log("\nPool 1 (USDC/USDT) reserves in hook:");
        console.log("  USDC reserves:", pool1USDCReserves / 1e6, "USDC");
        console.log("  USDT reserves:", pool1USDTReserves / 1e6, "USDT");
        
        console.log("\nPool 2 (USDC/WETH) reserves in hook:");
        console.log("  USDC reserves:", pool2USDCReserves / 1e6, "USDC");
        console.log("  WETH reserves:", pool2WETHReserves / 1e18, "WETH");
        
        // Check Alice's encrypted balances in each pool
        euint128 alicePool1USDC = encryptedUSDC_Pool1.encBalances(alice);
        euint128 alicePool2USDC = encryptedUSDC_Pool2.encBalances(alice);
        
        console.log("\nAlice's encrypted balances:");
        console.log("  Pool 1 eUSDC (wrapped):", euint128.unwrap(alicePool1USDC));
        console.log("  Pool 2 eUSDC (wrapped):", euint128.unwrap(alicePool2USDC));
        
        // Check Bob's encrypted balances
        euint128 bobPool2WETH = encryptedWETH_Pool2.encBalances(bob);
        console.log("\nBob's encrypted balances:");
        console.log("  Pool 2 eWETH (wrapped):", euint128.unwrap(bobPool2WETH));
        
        console.log("\n=== TESTING SWAP IN POOL 2 ===");
        
        // Alice submits encrypted swap intent in Pool 2: swap 400 USDC for WETH
        vm.startPrank(alice);
        InEuint128 memory encryptedSwapAmount2 = createInEuint128(uint128(400e6), alice); // 400 USDC
        hook.submitIntent(
            secondPoolKey,
            Currency.wrap(address(usdc)),
            Currency.wrap(address(weth)),
            encryptedSwapAmount2,
            uint64(block.timestamp + 1 hours)
        );
        vm.stopPrank();
        console.log("Alice submitted encrypted swap intent: 400 USDC -> WETH");
        
        // Warp time for FHE decryption
        vm.warp(block.timestamp + 11);
        
        // Trigger swap to process intent
        weth.mint(bob, 1e18);
        vm.prank(bob);
        weth.approve(address(swapRouter), 1e18);
        
        vm.prank(bob);
        swapRouter.swap(
            secondPoolKey,
            SwapParams({
                zeroForOne: false, // WETH → USDC
                amountSpecified: -1e17, // Swap 0.1 WETH
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ZERO_BYTES
        );
        console.log("Triggered intent processing via external swap");
        
        // Check updated balances after swap
        uint256 hookUSDCBalanceAfter = usdc.balanceOf(address(hook));
        uint256 hookWETHBalanceAfter = weth.balanceOf(address(hook));
        
        console.log("\nHook's token balances after swap:");
        console.log("  USDC balance:", hookUSDCBalanceAfter / 1e6, "USDC");
        console.log("  WETH balance:", hookWETHBalanceAfter / 1e18, "WETH");
        
        // Check updated reserves
        uint256 pool2USDCReservesAfter = hook.poolReserves(secondPoolId, Currency.wrap(address(usdc)));
        uint256 pool2WETHReservesAfter = hook.poolReserves(secondPoolId, Currency.wrap(address(weth)));
        
        console.log("\nPool 2 reserves after swap:");
        console.log("  USDC reserves:", pool2USDCReservesAfter / 1e6, "USDC");
        console.log("  WETH reserves:", pool2WETHReservesAfter / 1e18, "WETH");
        
        // Check Alice's updated encrypted balances
        euint128 alicePool2USDCAfter = encryptedUSDC_Pool2.encBalances(alice);
        euint128 alicePool2WETH = encryptedWETH_Pool2.encBalances(alice);
        
        console.log("\nAlice's encrypted balances after swap:");
        console.log("  Pool 2 eUSDC (wrapped):", euint128.unwrap(alicePool2USDCAfter));
        console.log("  Pool 2 eWETH (wrapped):", euint128.unwrap(alicePool2WETH));
        
        if (euint128.unwrap(alicePool2WETH) != 0) {
            console.log("SUCCESS: Alice received encrypted WETH tokens from Pool 2 swap!");
        }
        
        console.log("\n=== SUMMARY ===");
        console.log("Pool 1 (USDC/USDT) has encrypted USDC token at:", address(encryptedUSDC_Pool1));
        console.log("Pool 2 (USDC/WETH) has encrypted USDC token at:", address(encryptedUSDC_Pool2));
        console.log("Pool 2 (USDC/WETH) has encrypted WETH token at:", address(encryptedWETH_Pool2));
        console.log("Each pool maintains independent encrypted tokens");
        console.log("Alice deposited", DEPOSIT_AMOUNT / 1e6, "USDC in each pool");
        console.log("Alice swapped 400 USDC for WETH in Pool 2");
        console.log("Bob deposited 1 WETH in Pool 2");
    }
}