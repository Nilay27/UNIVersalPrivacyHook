import { ethers } from "hardhat";

// Uniswap V4 contracts on Sepolia
const SEPOLIA_CONTRACTS = {
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  PoolModifyLiquidityTest: "0x0c478023803a644c94c4ce1c1e7b9a087e411b0a",
};

// Pool configuration
const FEE = 3000; // 0.3%
const TICK_SPACING = 60; // Standard for 0.3% fee tier
const SQRT_PRICE_X96 = "79228162514264337593543950336"; // Initial price 1:1

// Liquidity parameters
const TICK_LOWER = -60; // Narrow range for concentrated liquidity
const TICK_UPPER = 60;
const LIQUIDITY_AMOUNT = ethers.parseUnits("10000", 6); // 10k tokens
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

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Force Send Liquidity Transaction");
  console.log("=================================\n");
  console.log("Deployer:", deployer.address);

  // Contract addresses
  const hookAddress = "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080";
  const usdcAddress = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
  const usdtAddress = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";

  // Sort currencies
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

  // Get the contract interface
  const modifyLiquidityTest = await ethers.getContractAt(
    "IPoolModifyLiquidityTest",
    SEPOLIA_CONTRACTS.PoolModifyLiquidityTest,
    deployer
  );

  // Ensure approvals are in place
  const mockUSDC = await ethers.getContractAt("MockERC20", usdcAddress, deployer);
  const mockUSDT = await ethers.getContractAt("MockERC20", usdtAddress, deployer);
  
  const approveAmount = ethers.parseUnits("1000000", 6);
  console.log("Setting up approvals...");
  
  try {
    await (await mockUSDC.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, approveAmount)).wait();
    await (await mockUSDT.approve(SEPOLIA_CONTRACTS.PoolModifyLiquidityTest, approveAmount)).wait();
    console.log("✅ Tokens approved\n");
  } catch (e) {
    console.log("⚠️  Approval might have failed or already set\n");
  }

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

  console.log("Liquidity Parameters:");
  console.log("  Tick Lower:", modifyPositionParams.tickLower);
  console.log("  Tick Upper:", modifyPositionParams.tickUpper);
  console.log("  Liquidity Delta:", modifyPositionParams.liquidityDelta.toString());
  console.log();

  // Encode the transaction data
  const txData = modifyLiquidityTest.interface.encodeFunctionData(
    "modifyLiquidity",
    [poolKey, modifyPositionParams, "0x"]
  );

  // Build transaction with high gas limit
  const unsignedTx = {
    to: SEPOLIA_CONTRACTS.PoolModifyLiquidityTest,
    data: txData,
    value: 0,
    gasLimit: 2000000, // Very high gas limit
    maxFeePerGas: ethers.parseUnits("50", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
    nonce: await deployer.getNonce(),
    chainId: 11155111, // Sepolia
    type: 2, // EIP-1559 transaction
  };

  console.log("Transaction Details:");
  console.log("  To:", unsignedTx.to);
  console.log("  Gas Limit:", unsignedTx.gasLimit);
  console.log("  Max Fee:", ethers.formatUnits(unsignedTx.maxFeePerGas!, "gwei"), "gwei");
  console.log("  Nonce:", unsignedTx.nonce);
  console.log("  Data:", txData.substring(0, 10) + "...");
  console.log();

  console.log("========================================");
  console.log("FORCE SENDING TRANSACTION");
  console.log("========================================\n");
  
  console.log("This will force send the transaction even if it might fail.");
  console.log("You can then analyze it in Tenderly.\n");

  try {
    const tx = await deployer.sendTransaction(unsignedTx);
    console.log("✅ Transaction sent!");
    console.log("Transaction hash:", tx.hash);
    console.log("\n🔍 View on Etherscan:");
    console.log(`https://sepolia.etherscan.io/tx/${tx.hash}`);
    console.log("\n🔍 Analyze on Tenderly:");
    console.log(`https://dashboard.tenderly.co/tx/sepolia/${tx.hash}`);
    
    console.log("\nWaiting for transaction...");
    try {
      const receipt = await tx.wait();
      console.log("\n✅ Transaction confirmed!");
      console.log("Gas used:", receipt.gasUsed.toString());
      console.log("Status:", receipt.status === 1 ? "Success" : "Failed");
      
      if (receipt.logs.length > 0) {
        console.log("\nEvents emitted:", receipt.logs.length);
      }
    } catch (waitError: any) {
      console.log("\n❌ Transaction failed!");
      console.log("Error:", waitError.message);
      console.log("\nCheck Tenderly for detailed error analysis.");
    }
  } catch (error: any) {
    console.log("❌ Failed to send transaction!");
    console.log("Error:", error.message);
    
    if (error.data) {
      console.log("\nError data:", error.data);
    }
    
    if (error.transaction) {
      console.log("\nYou can manually send this transaction:");
      console.log(JSON.stringify(error.transaction, null, 2));
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
