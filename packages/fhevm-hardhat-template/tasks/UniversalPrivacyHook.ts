import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

// Deployed contract addresses on Sepolia
const DEPLOYED_CONTRACTS = {
  UniversalPrivacyHook: "0xf5DB4551075284285245549aa2f108fFbC9E0080",
  MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
  MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
};

const FEE = 3000;
const TICK_SPACING = 60;
const POOL_ID = "0x45ED5ADDCE08D124120CAB1576A4B57D2FDC3AAC9D108E2722593D6B0BB1DA8C";

/**
 * Test deposit functionality
 * Example: npx hardhat --network sepolia task:test-deposit
 */
task("task:test-deposit", "Test deposit to UniversalPrivacyHook")
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    
    console.log("\n==================== Testing Deposit ====================\n");
    
    const [signer] = await ethers.getSigners();
    console.log("Testing with account:", signer.address);
    
    // Get contract instances
    const hook = await ethers.getContractAt(
      "UniversalPrivacyHook",
      DEPLOYED_CONTRACTS.UniversalPrivacyHook
    );
    
    const usdc = await ethers.getContractAt("MockERC20", DEPLOYED_CONTRACTS.MockUSDC);
    
    // Build pool key
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
    
    const depositAmount = ethers.parseUnits("100", 6);
    
    // Check balance
    const usdcBalance = await usdc.balanceOf(signer.address);
    console.log("Current USDC balance:", ethers.formatUnits(usdcBalance, 6), "USDC");
    
    // Mint if needed
    if (usdcBalance < depositAmount) {
      console.log("\nMinting USDC for testing...");
      const mintTx = await usdc.mint(signer.address, depositAmount);
      await mintTx.wait();
      console.log("Minted", ethers.formatUnits(depositAmount, 6), "USDC");
    }
    
    // Approve
    console.log("\nApproving hook to spend USDC...");
    const approveTx = await usdc.approve(DEPLOYED_CONTRACTS.UniversalPrivacyHook, depositAmount);
    await approveTx.wait();
    console.log("Approved", ethers.formatUnits(depositAmount, 6), "USDC");
    
    // Deposit
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
    
    // Check encrypted token
    const encryptedTokenAddress = await hook.poolEncryptedTokens(POOL_ID, currency0);
    console.log("\nEncrypted token address:", encryptedTokenAddress);
    
    if (encryptedTokenAddress !== ethers.ZeroAddress) {
      const encToken = await ethers.getContractAt("HybridFHERC20", encryptedTokenAddress);
      const encBalance = await encToken.encBalances(signer.address);
      console.log("Encrypted token balance:", ethers.formatUnits(encBalance, 6));
    }
    
    console.log("\n✅ Deposit test complete!");
  });

/**
 * Test submit intent functionality
 * Example: npx hardhat --network sepolia task:test-intent --amount 10
 */
task("task:test-intent", "Test submit intent to UniversalPrivacyHook")
  .addOptionalParam("amount", "Amount to swap (default: 10)", "10")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, fhevm } = hre;
    
    console.log("\n==================== Testing Submit Intent ====================\n");
    
    // Initialize FHE for CLI
    await fhevm.initializeCLIApi();
    
    const [signer] = await ethers.getSigners();
    console.log("Testing with account:", signer.address);
    
    // Get contract instances
    const hook = await ethers.getContractAt(
      "UniversalPrivacyHook",
      DEPLOYED_CONTRACTS.UniversalPrivacyHook
    );
    
    // Build pool key
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
    
    // Check encrypted token
    const encryptedTokenAddress = await hook.poolEncryptedTokens(POOL_ID, currency0);
    console.log("Encrypted token address:", encryptedTokenAddress);
    
    if (encryptedTokenAddress === ethers.ZeroAddress) {
      console.error("❌ No encrypted token found. Please run deposit first!");
      return;
    }
    
    const encToken = await ethers.getContractAt("HybridFHERC20", encryptedTokenAddress);
    const encBalance = await encToken.encBalances(signer.address);
    console.log("Current encrypted token balance:", ethers.formatUnits(encBalance, 6));
    
    // if (encBalance === 0n) {
    //   console.error("❌ No encrypted tokens. Please run deposit first!");
    //   return;
    // }
    
    // Create encrypted amount
    const swapAmount = BigInt(taskArguments.amount) * 10n**6n;
    console.log("\nPreparing to swap", swapAmount / 10n**6n, "tokens");
    
    console.log("Creating encrypted input...");
    const encryptedInput = await fhevm
      .createEncryptedInput(DEPLOYED_CONTRACTS.UniversalPrivacyHook, signer.address)
      .add128(Number(swapAmount))
      .encrypt();
    
    console.log("Encrypted amount handle:", encryptedInput.handles[0]);
    console.log("Input proof length:", encryptedInput.inputProof.length, "bytes");
    
    // Submit intent
    const tokenIn = currency0;
    const tokenOut = currency1;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    console.log("\nSubmitting swap intent:");
    console.log("- Token In:", tokenIn);
    console.log("- Token Out:", tokenOut);
    console.log("- Amount:", swapAmount / 10n**6n, "tokens (encrypted)");
    console.log("- Deadline:", new Date(deadline * 1000).toLocaleString());
    
    const gasEstimate = await hook.submitIntent.estimateGas(
      poolKey,
      tokenIn,
      tokenOut,
      encryptedInput.handles[0],
      encryptedInput.inputProof,
      deadline
    );
    const gasLimit = (gasEstimate * 120n) / 100n; // 20% buffer
    console.log("\nGas estimate:", gasEstimate.toString());
    console.log("Using gas limit:", gasLimit.toString());
    
    const submitTx = await hook.submitIntent(
      poolKey,
      tokenIn,
      tokenOut,
      encryptedInput.handles[0],
      encryptedInput.inputProof,
      deadline,
      { gasLimit }
    );
    
    console.log("\nTransaction sent:", submitTx.hash);
    console.log("Waiting for confirmation...");
    const receipt = await submitTx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    
    // Check for event
    const intentEvent = receipt.logs.find(
      (log: any) => log.topics[0] === ethers.id("IntentSubmitted(bytes32,address,address,address,bytes32)")
    );
    
    if (intentEvent) {
      console.log("\n✅ Intent submitted successfully!");
      const intentId = intentEvent.topics[4];
      console.log("Intent ID:", intentId);
    }
    
    console.log("\n⏳ Intent will be processed asynchronously by FHE Gateway");
  });