import { ethers } from "hardhat";
import { deployments } from "hardhat";
const { ethers, deployments, fhevm } = hre;


// Deployed contract addresses on Sepolia
const DEPLOYED_CONTRACTS = {
  UniversalPrivacyHook: "0xf5DB4551075284285245549aa2f108fFbC9E0080", // Your deployed hook
  MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1", // Will load from deployments
  MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D", // Will load from deployments
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
};

// Pool configuration (must match your deployed pool)
const FEE = 3000; // 0.3%
const TICK_SPACING = 60;

async function main() {
  console.log("\n==================== Testing Submit Intent ====================\n");
  
  // Initialize FHE for CLI usage
  await fhevm.initializeCLIApi();
  
  // Get signer
  const [signer] = await ethers.getSigners();
  console.log("Testing with account:", signer.address);
  
  console.log("Using contracts:");
  console.log("- UniversalPrivacyHook:", DEPLOYED_CONTRACTS.UniversalPrivacyHook);
  console.log("- MockUSDC:", DEPLOYED_CONTRACTS.MockUSDC);
  console.log("- MockUSDT:", DEPLOYED_CONTRACTS.MockUSDT);
  
  // Get contract instances
  const hook = await ethers.getContractAt(
    "UniversalPrivacyHook",
    DEPLOYED_CONTRACTS.UniversalPrivacyHook
  );
  
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
    // Step 1: Check encrypted token balance
    // Use the actual poolId from the Initialize event
    const poolId = "0x45ED5ADDCE08D124120CAB1576A4B57D2FDC3AAC9D108E2722593D6B0BB1DA8C";
    
    const encryptedTokenAddress = await hook.poolEncryptedTokens(poolId, currency0);
    console.log("\nEncrypted token address for currency0:", encryptedTokenAddress);
    
    if (encryptedTokenAddress === ethers.ZeroAddress) {
      console.error("❌ No encrypted token found. Please run deposit first!");
      return;
    }
    
    const encToken = await ethers.getContractAt("HybridFHERC20", encryptedTokenAddress);
    const encBalance = await encToken.encBalances(signer.address);
    console.log("Current encrypted token balance:", ethers.formatUnits(encBalance, 6));
    
    if (encBalance === 0n) {
      console.error("❌ No encrypted tokens. Please run deposit first!");
      return;
    }
    
    // Step 2: Create encrypted amount for swap
    const swapAmount = 10n * 10n**6n; // 10 tokens with 6 decimals
    console.log("\nPreparing to swap", swapAmount / 10n**6n, "tokens");
    
    // Create encrypted input
    console.log("Creating encrypted input...");
    
    // For Sepolia, we need to use the network's FHE configuration
    // The fhevm plugin handles network detection
    const encryptedInput = await fhevm
      .createEncryptedInput(DEPLOYED_CONTRACTS.UniversalPrivacyHook, signer.address)
      .add128(swapAmount)
      .encrypt();
    
    console.log("Encrypted amount handle:", encryptedInput.handles[0]);
    console.log("Input proof length:", encryptedInput.inputProof.length, "bytes");
    
    // Step 3: No approval needed - transferFromEncrypted doesn't check allowances
    // Note: This is actually a security issue in the HybridFHERC20 contract
    console.log("\n⚠️  Note: No approval needed - transferFromEncrypted doesn't check allowances");
    
    // Step 4: Submit intent
    const tokenIn = currency0;  // Swapping currency0 for currency1
    const tokenOut = currency1;
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    
    console.log("\nSubmitting swap intent:");
    console.log("- Token In:", tokenIn);
    console.log("- Token Out:", tokenOut);
    console.log("- Encrypted Amount:", swapAmount / 10n**6n, "tokens (encrypted)");
    console.log("- Deadline:", new Date(deadline * 1000).toLocaleString());
    
    const submitTx = await hook.submitIntent(
      poolKey,
      tokenIn,
      tokenOut,
      encryptedInput.handles[0],
      encryptedInput.inputProof,
      deadline
    );
    
    console.log("\nTransaction sent:", submitTx.hash);
    const receipt = await submitTx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    
    // Step 5: Check events
    const intentEvent = receipt.logs.find(
      (log: any) => log.topics[0] === ethers.id("IntentSubmitted(bytes32,address,address,address,bytes32)")
    );
    
    if (intentEvent) {
      console.log("\n✅ Intent submitted successfully!");
      console.log("Intent event found in transaction");
      
      // Decode intent ID from event
      const intentId = intentEvent.topics[4]; // Last topic is intentId
      console.log("Intent ID:", intentId);
      
      // Check intent details
      const intent = await hook.intents(intentId);
      console.log("\nIntent details:");
      console.log("- Owner:", intent.owner);
      console.log("- Token In:", intent.tokenIn);
      console.log("- Token Out:", intent.tokenOut);
      console.log("- Deadline:", new Date(Number(intent.deadline) * 1000).toLocaleString());
      console.log("- Processed:", intent.processed);
    }
    
    console.log("\n⏳ Note: Intent will be processed asynchronously by FHE Gateway");
    console.log("The gateway will decrypt the amount and call back to execute the swap");
    
    console.log("\n==================== Submit Intent Test Complete ====================\n");
    
  } catch (error) {
    console.error("\n❌ Error during submit intent:", error);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });