import { ethers, fhevm } from "hardhat";

// Deployed contract addresses on Sepolia
const DEPLOYED_CONTRACTS = {
  UniversalPrivacyHook: "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080", // Your deployed hook
  MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1", // Will load from deployments
  MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D", // Will load from deployments
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
};

// Pool configuration (must match your deployed pool)
const FEE = 3000; // 0.3%
const TICK_SPACING = 60;

async function main() {
  console.log("\n==================== Testing Deposit ====================\n");
  
  // Get signer
  const [signer] = await ethers.getSigners();
  console.log("Testing with account:", signer.address);
  console.log("Setting up pool with account:", signer.address);
  
  // Verify deployer address
  const expectedAddress = "0x0cD73A4E3d34D5488BC4E547fECeDAc86305dB9d";
  if (signer.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    console.error(`\n❌ ERROR: Wrong deployer address!`);
    console.error(`   Expected: ${expectedAddress}`);
    console.error(`   Got: ${signer.address}`);
    console.error(`\n   Please check your PRIVATE_KEY in .env file`);
    process.exit(1);
  }
  console.log("✅ Correct deployer address\n");
  
  
  console.log("Using contracts:");
  console.log("- UniversalPrivacyHook:", DEPLOYED_CONTRACTS.UniversalPrivacyHook);
  console.log("- MockUSDC:", DEPLOYED_CONTRACTS.MockUSDC);
  console.log("- MockUSDT:", DEPLOYED_CONTRACTS.MockUSDT);
  
  // Get contract instances
  const hook = await ethers.getContractAt(
    "UniversalPrivacyHook",
    DEPLOYED_CONTRACTS.UniversalPrivacyHook
  );
  
  const usdc = await ethers.getContractAt("MockERC20", DEPLOYED_CONTRACTS.MockUSDC);
  const usdt = await ethers.getContractAt("MockERC20", DEPLOYED_CONTRACTS.MockUSDT);
  
  // Amount to deposit (100 USDC with 6 decimals)
  const depositAmount = ethers.parseUnits("100", 6);
  
  // Build the PoolKey struct
  // Sort currencies (lower address first)
  let currency0 = DEPLOYED_CONTRACTS.MockUSDC;
  let currency1 = DEPLOYED_CONTRACTS.MockUSDT;
  if (currency0.toLowerCase() > currency1.toLowerCase()) {
    [currency0, currency1] = [currency1, currency0];
  }
  
  const poolKey = {
    currency0: currency0,
    currency1: currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: DEPLOYED_CONTRACTS.UniversalPrivacyHook
  };
  
  console.log("\nPool Key:");
  console.log("- Currency0:", poolKey.currency0);
  console.log("- Currency1:", poolKey.currency1);
  console.log("- Fee:", poolKey.fee);
  console.log("- TickSpacing:", poolKey.tickSpacing);
  console.log("- Hooks:", poolKey.hooks);
  
  try {
    // Step 1: Check current balances
    const usdcBalance = await usdc.balanceOf(signer.address);
    console.log("\nCurrent USDC balance:", ethers.formatUnits(usdcBalance, 6), "USDC");
    
    // Step 2: Mint some USDC if needed (for testing)
    if (usdcBalance < depositAmount) {
      console.log("\nMinting USDC for testing...");
      const mintTx = await usdc.mint(signer.address, depositAmount);
      await mintTx.wait();
      console.log("Minted", ethers.formatUnits(depositAmount, 6), "USDC");
    }
    
    // Step 3: Approve hook to spend USDC
    console.log("\nApproving hook to spend USDC...");
    const approveTx = await usdc.approve(DEPLOYED_CONTRACTS.UniversalPrivacyHook, depositAmount);
    await approveTx.wait();
    console.log("Approved", ethers.formatUnits(depositAmount, 6), "USDC");
    
    // Step 4: Check if encrypted token exists (optional)
    const poolId = "0x1706511516D9D7794D66A45EE230280F1B1D1D479311E7AAF38746C339CFA653"
    
    
    
    // Step 5: Deposit USDC
    console.log("\nDepositing USDC to hook...");
    const gasEstimate = await hook.deposit.estimateGas(poolKey, currency0, depositAmount);
    const gasLimit = (gasEstimate * 120n) / 100n; // 20% buffer
    console.log("Gas estimate:", gasEstimate.toString());
    console.log("Using gas limit:", gasLimit.toString());
    
    const depositTx = await hook.deposit(poolKey, currency0, depositAmount, { gasLimit });
    console.log("Transaction sent:", depositTx.hash);
    console.log("Waiting for confirmation...");
    
    const receipt = await depositTx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    
    // Step 6: Check events
    const depositEvent = receipt.logs.find(
      (log: any) => log.topics[0] === ethers.id("Deposited(bytes32,address,address,uint256)")
    );
    
    if (depositEvent) {
      console.log("\n✅ Deposit successful!");
      console.log("Deposit event found in transaction");
    }
    
    const encryptedTokenAddress = await hook.poolEncryptedTokens(poolId, currency0);
    console.log("\nEncrypted token address for USDC:", encryptedTokenAddress);
    // Step 7: Check encrypted token balance (if token was created)
    if (encryptedTokenAddress !== ethers.ZeroAddress) {
      const encToken = await ethers.getContractAt("HybridFHERC20", encryptedTokenAddress);
      const encBalance = await encToken.encBalances(signer.address);
      console.log("\nEncrypted token balance:", ethers.formatUnits(encBalance, 6));
    }
    
    console.log("\n==================== Deposit Test Complete ====================\n");
    
  } catch (error) {
    console.error("\n❌ Error during deposit:", error);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });