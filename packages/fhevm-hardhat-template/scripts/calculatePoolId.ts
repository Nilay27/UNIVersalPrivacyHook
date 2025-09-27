import { ethers } from "hardhat";

async function main() {
  // Your deployed addresses
  const contracts = {
    UniversalPrivacyHook: "0xf5DB4551075284285245549aa2f108fFbC9E0080",
    MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
    MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
  };

  // Pool configuration
  const FEE = 3000;
  const TICK_SPACING = 60;

  // Sort currencies (lower address first)
  let currency0 = contracts.MockUSDC;
  let currency1 = contracts.MockUSDT;
  if (currency0.toLowerCase() > currency1.toLowerCase()) {
    [currency0, currency1] = [currency1, currency0];
  }

  console.log("\n=== Pool Key Components ===");
  console.log("Currency0:", currency0);
  console.log("Currency1:", currency1);
  console.log("Fee:", FEE);
  console.log("TickSpacing:", TICK_SPACING);
  console.log("Hooks:", contracts.UniversalPrivacyHook);

  // Calculate poolId using the exact same method as Solidity
  const poolId = ethers.solidityPackedKeccak256(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, FEE, TICK_SPACING, contracts.UniversalPrivacyHook]
  );

  console.log("\n=== Calculated PoolId ===");
  console.log("PoolId:", poolId);

  console.log("\n=== For Etherscan Read Contract ===");
  console.log("Go to: https://sepolia.etherscan.io/address/" + contracts.UniversalPrivacyHook + "#readContract");
  console.log("\nFind 'poolEncryptedTokens' function and enter:");
  console.log("1st input (poolId):", poolId);
  console.log("2nd input (currency):", currency0);
  
  console.log("\n=== Alternative: Try with both currencies ===");
  console.log("For USDC token:");
  console.log("  poolId:", poolId);
  console.log("  currency:", currency0);
  console.log("\nFor USDT token:");
  console.log("  poolId:", poolId);
  console.log("  currency:", currency1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });