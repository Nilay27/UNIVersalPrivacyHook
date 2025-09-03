import { ethers } from "hardhat";
import { deployments } from "hardhat";

// Uniswap V4 contracts on Sepolia
const SEPOLIA_CONTRACTS = {
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  UniversalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
  PositionManager: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
  StateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
  Quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
  PoolSwapTest: "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee",
  PoolModifyLiquidityTest: "0x0c478023803a644c94c4ce1c1e7b9a087e411b0a",
  Permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

// Pool configuration
const FEE = 3000; // 0.3%
const TICK_SPACING = 60; // Standard for 0.3% fee tier
const SQRT_PRICE_X96 = "79228162514264337593543950336"; // Initial price 1:1
const MIN_SQRT_PRICE_PLUS_ONE  = 4295128740n; // TickMath.MIN_SQRT_PRICE + 1
const MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341n; // TickMath.MAX_SQRT_PRICE - 1

// Liquidity parameters
const TICK_LOWER = -60; // Narrow range for concentrated liquidity
const TICK_UPPER = 60;
const LIQUIDITY_AMOUNT = ethers.parseUnits("100000", 6); // 10k tokens

// ---- Liquidity math helpers (Uniswap v3/v4 style) ----
const Q96 = 2n ** 96n;

function tickToSqrtPriceX96(tick: number): bigint {
  // NOTE: using JS float math is fine for small |tick| like 60; we cast to bigint afterward
  const sqrt = Math.pow(1.0001, tick / 2);
  const x = BigInt(Math.floor(sqrt * Number(Q96)));
  return x;
}

function getLiquidityForAmount0(sqrtAX96: bigint, sqrtBX96: bigint, amount0: bigint): bigint {
  if (sqrtAX96 > sqrtBX96) [sqrtAX96, sqrtBX96] = [sqrtBX96, sqrtAX96];
  // L0 = amount0 * (sqrtA * sqrtB) / (sqrtB - sqrtA) / Q96
  const numerator = amount0 * (sqrtAX96 * sqrtBX96);
  const denominator = (sqrtBX96 - sqrtAX96) * Q96;
  return numerator / denominator;
}

function getLiquidityForAmount1(sqrtAX96: bigint, sqrtBX96: bigint, amount1: bigint): bigint {
  if (sqrtAX96 > sqrtBX96) [sqrtAX96, sqrtBX96] = [sqrtBX96, sqrtAX96];
  // L1 = amount1 * Q96 / (sqrtB - sqrtA)
  const numerator = amount1 * Q96;
  const denominator = (sqrtBX96 - sqrtAX96);
  return numerator / denominator;
}

function getLiquidityForAmounts(
  sqrtX96: bigint,
  sqrtAX96: bigint,
  sqrtBX96: bigint,
  amount0Desired: bigint,
  amount1Desired: bigint
): bigint {
  if (sqrtAX96 > sqrtBX96) [sqrtAX96, sqrtBX96] = [sqrtBX96, sqrtAX96];
  if (sqrtX96 <= sqrtAX96) {
    return getLiquidityForAmount0(sqrtAX96, sqrtBX96, amount0Desired);
  }
  if (sqrtX96 >= sqrtBX96) {
    return getLiquidityForAmount1(sqrtAX96, sqrtBX96, amount1Desired);
  }
  const liquidity0 = getLiquidityForAmount0(sqrtX96, sqrtBX96, amount0Desired);
  const liquidity1 = getLiquidityForAmount1(sqrtAX96, sqrtX96, amount1Desired);
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}
// ------------------------------------------------------

// --- Uniswap v4 custom error decoder ---
const ERROR_IFACE = new ethers.Interface([
  "error CurrencyNotSettled(address account, uint256 amount0, uint256 amount1)",
  "error PoolNotInitialized()",
  "error HookNotImplemented()",
  "error InvalidSqrtPriceLimit()",
  "error AlreadyInitialized()",
  "error TickNotAligned()",
  "error InsufficientInput()",
  "error InsufficientOutput()",
  "error BalanceNotSettled()",
  "error PriceLimitAfterSwap()"
]);

function decodeRevertData(data: string): string {
  try {
    const err = ERROR_IFACE.parseError(data);
    const args = Array.from(err.args || []).map((a: any) => (typeof a === "bigint" ? a.toString() : String(a)));
    return `${err.name}(${args.join(", ")})`;
  } catch {
    return "";
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Setting up pool with account:", deployer.address);
  
  // Verify deployer address
  const expectedAddress = "0x0cD73A4E3d34D5488BC4E547fECeDAc86305dB9d";
  if (deployer.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    console.error(`\n❌ ERROR: Wrong deployer address!`);
    console.error(`   Expected: ${expectedAddress}`);
    console.error(`   Got: ${deployer.address}`);
    console.error(`\n   Please check your PRIVATE_KEY in .env file`);
    process.exit(1);
  }
  console.log("✅ Correct deployer address\n");

  // Use our deployed and verified contracts
  const hookAddress = "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080";
  const usdcAddress = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
  const usdtAddress = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";

  console.log("\n========================================");
  console.log("Setting Up Uniswap V4 Pool on Sepolia");
  console.log("========================================\n");

  console.log("Using deployed contracts:");
  console.log("  Hook:", hookAddress);
  console.log("  MockUSDC:", usdcAddress);
  console.log("  MockUSDT:", usdtAddress);

  // Get contract instances
  const poolManager = await ethers.getContractAt(
    "IPoolManager",
    SEPOLIA_CONTRACTS.PoolManager,
    deployer
  );

  const mockUSDC = await ethers.getContractAt("MockERC20", usdcAddress, deployer);
  const mockUSDT = await ethers.getContractAt("MockERC20", usdtAddress, deployer);

  // Minimal ABI for our hook's deposit gate (poolKey, token, amount)
  const hookAbi = [
    "function deposit((address,address,uint24,int24,address) poolKey, address token, uint256 amount) external",
  ];
  const hook = new ethers.Contract(hookAddress, hookAbi, deployer);

  // Sort currencies (required by Uniswap V4)
  const currency0 = usdcAddress.toLowerCase() < usdtAddress.toLowerCase()
    ? usdcAddress
    : usdtAddress;
  const currency1 = currency0 === usdcAddress
    ? usdtAddress
    : usdcAddress;

  const poolKey = {
    currency0: currency0,
    currency1: currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: hookAddress,
  };

  console.log("\n1. Pool Configuration:");
  console.log("  Currency0:", currency0 === usdcAddress ? "USDC" : "USDT", currency0);
  console.log("  Currency1:", currency1 === usdcAddress ? "USDC" : "USDT", currency1);
  console.log("  Fee:", FEE / 10000, "%");
  console.log("  Tick Spacing:", TICK_SPACING);
  console.log("  Hook:", hookAddress);

  // // Step 1: Initialize pool
  console.log("\n2. Initializing pool...");
  try {
    const gasEstimate = await poolManager.initialize.estimateGas(poolKey, SQRT_PRICE_X96);
    const gasLimit = (gasEstimate * 120n) / 100n; // 20% buffer
    console.log("  Gas estimate:", gasEstimate.toString());
    console.log("  Using gas limit:", gasLimit.toString());
    
    const initTx = await poolManager.initialize(poolKey, SQRT_PRICE_X96, { gasLimit });
    console.log("  Tx hash:", initTx.hash);
    console.log("  Waiting for confirmation...");
    
    await initTx.wait();
    console.log("  ✅ Pool initialized successfully!");
  } catch (error: any) {
    if (error.message.includes("already initialized")) {
      console.log("  ℹ️  Pool already initialized");
    } else {
      console.error("  ❌ Failed to initialize pool:", error.message);
      return;
    }
  }

  // Step 2: Add liquidity using PoolModifyLiquidityTest
  console.log("\n3. Adding liquidity using PoolModifyLiquidityTest...");
  
  const modifyLiquidityTest = await ethers.getContractAt(
    "IPoolModifyLiquidityTest",
    SEPOLIA_CONTRACTS.PoolModifyLiquidityTest,
    deployer
  );

  // // Approve tokens to the test contract
  console.log("  Approving tokens...");
  await mockUSDC.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, ethers.parseUnits("1000000", 6));
  await mockUSDT.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, ethers.parseUnits("1000000", 6));
  console.log("  ✅ Approved tokens");

  // // Add liquidity
  console.log("  Adding liquidity...");

  // Compute a realistic liquidityDelta from desired token amounts and ticks
  const sqrtX96 = BigInt(SQRT_PRICE_X96); // current sqrt price (1:1)
  const sqrtLowerX96 = tickToSqrtPriceX96(TICK_LOWER);
  const sqrtUpperX96 = tickToSqrtPriceX96(TICK_UPPER);

  // Use up to LIQUIDITY_AMOUNT of EACH token (USDC & USDT) for minting
  const liquidityDelta = getLiquidityForAmounts(
    sqrtX96,
    sqrtLowerX96,
    sqrtUpperX96,
    LIQUIDITY_AMOUNT,
    LIQUIDITY_AMOUNT
  );
  console.log("  Computed liquidityDelta:", liquidityDelta.toString());

  const modifyPositionParams = {
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    liquidityDelta: liquidityDelta, // computed from desired token amounts
    salt: ethers.ZeroHash,
  };

  // Preflight: balances / allowances
  const [usdcBal, usdtBal, usdcAllow, usdtAllow] = await Promise.all([
    mockUSDC.balanceOf(deployer.address),
    mockUSDT.balanceOf(deployer.address),
    mockUSDC.allowance(deployer.address, SEPOLIA_CONTRACTS.PoolModifyLiquidityTest),
    mockUSDT.allowance(deployer.address, SEPOLIA_CONTRACTS.PoolModifyLiquidityTest),
  ]);
  console.log("  Balances -> USDC:", usdcBal.toString(), "USDT:", usdtBal.toString());
  console.log("  Allowances -> USDC:", usdcAllow.toString(), "USDT:", usdtAllow.toString());

  try {
    await modifyLiquidityTest.modifyLiquidity.staticCall(
      poolKey,
      modifyPositionParams,
      "0x"
    );
    console.log("  ✅ staticCall: add-liquidity would succeed (no revert)");
  } catch (e: any) {
    console.error("  ⚠️ staticCall revert:", e.shortMessage || e.message);
    // Extra diagnostics
    if (e.data) {
      console.error("  ↳ raw error data:", e.data);
    }
    if (e.reason) {
      console.error("  ↳ reason:", e.reason);
    }
  }

  try {
    const tx = await modifyLiquidityTest.modifyLiquidity(
      poolKey,
      modifyPositionParams,
      "0x" // No hook data
    );
    await tx.wait();
    console.log("  ✅ Liquidity added successfully!");
    console.log("  Tx hash:", tx.hash);
  } catch (error: any) {
    console.error("  ❌ Failed to add liquidity:", error.message);
    console.log("  You may need to manually add liquidity through the UI");
  }

  // Step 3: Test swap using PoolSwapTest
  // console.log("\n4. Testing swap functionality...");
  // const swapTest = await ethers.getContractAt(
  //   "IPoolSwapTest",
  //   SEPOLIA_CONTRACTS.PoolSwapTest,
  //   deployer
  // );

  // // Approve tokens for swap test
  // const swapAmount = ethers.parseUnits("10", 6); // 100 USDC
  // const allowanceAmount = ethers.parseUnits("100000", 6);
  // const approveTx = await mockUSDC.approve(SEPOLIA_CONTRACTS.PoolSwapTest, allowanceAmount);
  // await approveTx.wait();
  // console.log("  Approved 100000 USDC for test swap");

  // const [allowToRouter, allowToPermit2] = await Promise.all([
  //   mockUSDC.allowance(deployer.address, SEPOLIA_CONTRACTS.PoolSwapTest),
  //   mockUSDC.allowance(deployer.address, SEPOLIA_CONTRACTS.Permit2),
  // ]);
  // console.log("  Allowances -> PoolSwapTest:", allowToRouter.toString(), "Permit2:", allowToPermit2.toString());

  // const zeroForOne = currency0 === usdcAddress; // Swap USDC for USDT

  // const swapParams = {
  //   zeroForOne: zeroForOne,
  //   amountSpecified: swapAmount,
  //   sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
  // };

  //   const testSettings = {
  //     takeClaims: false,
  //     settleUsingBurn: false
  //   };

  //   // Dry-run to surface precise revert reason & selector
  //   try {
  //     await swapTest.swap.staticCall(
  //       poolKey,
  //       swapParams,
  //       testSettings,
  //       "0x"
  //     );
  //     console.log("  ✅ staticCall: swap would succeed");
  //   } catch (e: any) {
  //     console.error("  ⚠️ staticCall revert:", e.shortMessage || e.message);
  //     if (e.data) {
  //       console.error("  ↳ raw error data:", e.data);
  //       const decoded = decodeRevertData(e.data);
  //       if (decoded) console.error("  ↳ decoded:", decoded);
  //     }
  //     if (e.reason) console.error("  ↳ reason:", e.reason);
  //   }

  // try {
  //   console.log("  Executing test swap...");
  //   const swapTx = await swapTest.swap(
  //     poolKey,
  //     swapParams,
  //     testSettings,
  //     "0x" // No hook data
  //   );
  //   await swapTx.wait();
  //   console.log("  ✅ Test swap successful!");
  //   console.log("  Tx hash:", swapTx.hash);
  // } catch (error: any) {
  //   console.error("  ⚠️  Test swap failed:", error.shortMessage || error.message);
  //   if (error.data) {
  //     console.error("  ↳ raw error data:", error.data);
  //     const decoded = decodeRevertData(error.data);
  //     if (decoded) console.error("  ↳ decoded:", decoded);
  //   }
  //   if (error.reason) console.error("  ↳ reason:", error.reason);
  //   console.log("  This is expected if the hook requires special handling");
  // }

  console.log("\n========================================");
  console.log("Pool Setup Complete!");
  console.log("========================================");
  
  console.log("\n📋 Summary:");
  console.log("  Pool Manager:", SEPOLIA_CONTRACTS.PoolManager);
  console.log("  Pool initialized with hook:", hookAddress);
  console.log("  Liquidity added:", LIQUIDITY_AMOUNT.toString(), "units");
  
  console.log("\n📝 Next Steps:");
  console.log("1. Deposit tokens to get encrypted tokens via hook");
  console.log("2. Submit encrypted intents for privacy swaps");
  console.log("3. Monitor intent processing and settlements");
  
  console.log("\n🔗 Useful Links:");
  console.log("  Swap Router:", SEPOLIA_CONTRACTS.UniversalRouter);
  console.log("  Position Manager:", SEPOLIA_CONTRACTS.PositionManager);
  console.log("  State View:", SEPOLIA_CONTRACTS.StateView);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });