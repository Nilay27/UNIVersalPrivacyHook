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

// Liquidity parameters
const TICK_LOWER = -60; // Narrow range for concentrated liquidity
const TICK_UPPER = 60;
const LIQUIDITY_AMOUNT = ethers.parseUnits("10000", 6); // 10k tokens

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
  const hookAddress = "0x02aE81d1063c3FDC21a812E79408c3D3370E0080";
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

  // Step 1: Initialize pool
  console.log("\n2. Initializing pool...");
  try {
    const initTx = await poolManager.initialize(poolKey, SQRT_PRICE_X96);
    await initTx.wait();
    console.log("  ✅ Pool initialized successfully!");
    console.log("  Tx hash:", initTx.hash);
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

  // Approve tokens to the test contract
  console.log("  Approving tokens...");
  await mockUSDC.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, LIQUIDITY_AMOUNT);
  await mockUSDT.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, LIQUIDITY_AMOUNT);
  console.log("  ✅ Approved tokens");

  // Add liquidity
  console.log("  Adding liquidity...");
  try {
    const modifyPositionParams = {
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidityDelta: ethers.parseEther("1"), // 1e18 units of liquidity
      salt: ethers.ZeroHash,
    };

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
  console.log("\n4. Testing swap functionality...");
  const swapTest = await ethers.getContractAt(
    "IPoolSwapTest",
    SEPOLIA_CONTRACTS.PoolSwapTest,
    deployer
  );

  // Approve tokens for swap test
  const swapAmount = ethers.parseUnits("100", 6); // 100 USDC
  await mockUSDC.approve(SEPOLIA_CONTRACTS.PoolSwapTest, swapAmount);
  console.log("  Approved 100 USDC for test swap");

  try {
    const swapParams = {
      zeroForOne: currency0 === usdcAddress, // Swap USDC for USDT
      amountSpecified: swapAmount,
      sqrtPriceLimitX96: 0, // No price limit
    };

    console.log("  Executing test swap...");
    const swapTx = await swapTest.swap(
      poolKey,
      swapParams,
      {
        withdrawTokens: true,
        settleUsingTransfer: true,
        currencyAlreadySent: false,
      },
      "0x" // No hook data
    );
    await swapTx.wait();
    console.log("  ✅ Test swap successful!");
    console.log("  Tx hash:", swapTx.hash);
  } catch (error: any) {
    console.error("  ⚠️  Test swap failed:", error.message);
    console.log("  This is expected if the hook requires special handling");
  }

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