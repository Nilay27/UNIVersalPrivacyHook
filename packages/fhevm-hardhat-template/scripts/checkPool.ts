import { ethers } from "hardhat";

const SEPOLIA_CONTRACTS = {
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  StateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  // Our deployed contracts
  const hookAddress = "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080";
  const usdcAddress = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
  const usdtAddress = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";
  
  // Sort currencies
  const currency0 = usdcAddress.toLowerCase() < usdtAddress.toLowerCase()
    ? usdcAddress : usdtAddress;
  const currency1 = currency0 === usdcAddress ? usdtAddress : usdcAddress;
  
  const poolKey = {
    currency0: currency0,
    currency1: currency1,
    fee: 3000,
    tickSpacing: 60,
    hooks: hookAddress,
  };

  console.log("\n========================================");
  console.log("Checking Pool State on Sepolia");
  console.log("========================================\n");
  
  console.log("Pool Key:");
  console.log("  Currency0 (USDC):", currency0);
  console.log("  Currency1 (USDT):", currency1);
  console.log("  Fee:", poolKey.fee);
  console.log("  Tick Spacing:", poolKey.tickSpacing);
  console.log("  Hook:", poolKey.hooks);
  
  // Get pool ID (keccak256 hash of the pool key)
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedPoolKey = abiCoder.encode(
    ["tuple(address,address,uint24,int24,address)"],
    [[currency0, currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]]
  );
  const poolId = ethers.keccak256(encodedPoolKey);
  console.log("\nPool ID:", poolId);
  
  // Check pool initialization on PoolManager
  const poolManager = await ethers.getContractAt(
    ["function getSlot0(bytes32) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"],
    SEPOLIA_CONTRACTS.PoolManager,
    signer
  );
  
  try {
    const slot0 = await poolManager.getSlot0(poolId);
    console.log("\n✅ Pool is initialized!");
    console.log("Pool State:");
    console.log("  sqrtPriceX96:", slot0.sqrtPriceX96.toString());
    console.log("  Current tick:", slot0.tick.toString());
    console.log("  Protocol fee:", slot0.protocolFee.toString());
    console.log("  LP fee:", slot0.lpFee.toString());
    
    // Calculate approximate price from sqrtPriceX96
    const sqrtPrice = Number(slot0.sqrtPriceX96) / (2 ** 96);
    const price = sqrtPrice ** 2;
    console.log("  Approximate price:", price.toFixed(6));
    
  } catch (error: any) {
    console.log("\n❌ Pool not found or not initialized");
    console.log("Error:", error.message);
  }
  
  // Check hook state
  const hook = await ethers.getContractAt(
    ["function poolEncryptedTokens(bytes32,address) external view returns (address)"],
    hookAddress,
    signer
  );
  
  try {
    const encryptedUSDC = await hook.poolEncryptedTokens(poolId, currency0);
    const encryptedUSDT = await hook.poolEncryptedTokens(poolId, currency1);
    
    console.log("\nHook State:");
    console.log("  Encrypted USDC token:", encryptedUSDC);
    console.log("  Encrypted USDT token:", encryptedUSDT);
    
    if (encryptedUSDC === ethers.ZeroAddress) {
      console.log("  ⚠️  No encrypted tokens created yet");
      console.log("  Encrypted tokens are created on first deposit");
    }
  } catch (error) {
    console.log("\nCouldn't query hook state");
  }
  
  console.log("\n========================================");
  console.log("Pool Check Complete!");
  console.log("========================================");
  console.log("\nNext steps:");
  console.log("1. If pool is initialized, you can deposit tokens to the hook");
  console.log("2. The hook will create encrypted tokens on first deposit");
  console.log("3. Then you can submit encrypted intents for privacy swaps");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });