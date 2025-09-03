import { run } from "hardhat";

async function main() {
  console.log("\n========================================");
  console.log("Verifying Contracts on Sepolia");
  console.log("========================================\n");

  // Actual deployed contracts
  const contracts = {
    UniversalPrivacyHook: "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080",
    MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
    MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
    DeterministicDeployFactory: "0xC43192FA7dE17d93e03a80FcaB68Ff0Cb0c358cf",
    EncryptedToken: "0xeB0Afa59Dd28744028325Fd825AaF5A10ceC79EF" // Add the encrypted token
  };

  console.log("Deployed contracts to verify:");
  console.log("  UniversalPrivacyHook:", contracts.UniversalPrivacyHook);
  console.log("  MockUSDC:", contracts.MockUSDC);
  console.log("  MockUSDT:", contracts.MockUSDT);
  console.log("  Factory:", contracts.DeterministicDeployFactory);
  console.log("  EncryptedToken:", contracts.EncryptedToken);

  // // Verify MockUSDC
  // console.log("\n1. Verifying MockUSDC...");
  // try {
  //   await run("verify:verify", {
  //     address: contracts.MockUSDC,
  //     constructorArguments: ["USD Coin", "USDC", 6],
  //     contract: "contracts/test/MockERC20.sol:MockERC20",
  //   });
  //   console.log("  ✅ MockUSDC verified");
  // } catch (error: any) {
  //   if (error.message.includes("already verified")) {
  //     console.log("  ℹ️  MockUSDC already verified");
  //   } else {
  //     console.error("  ❌ Failed to verify MockUSDC:", error.message);
  //   }
  // }

  // // Verify MockUSDT
  // console.log("\n2. Verifying MockUSDT...");
  // try {
  //   await run("verify:verify", {
  //     address: contracts.MockUSDT,
  //     constructorArguments: ["Tether USD", "USDT", 6],
  //     contract: "contracts/test/MockERC20.sol:MockERC20",
  //   });
  //   console.log("  ✅ MockUSDT verified");
  // } catch (error: any) {
  //   if (error.message.includes("already verified")) {
  //     console.log("  ℹ️  MockUSDT already verified");
  //   } else {
  //     console.error("  ❌ Failed to verify MockUSDT:", error.message);
  //   }
  // }

  // // Verify UniversalPrivacyHook
  // console.log("\n3. Verifying UniversalPrivacyHook...");
  // try {
  //   await run("verify:verify", {
  //     address: contracts.UniversalPrivacyHook,
  //     constructorArguments: ["0xE03A1074c86CFeDd5C142C4F04F1a1536e203543"], // Sepolia PoolManager
  //     contract: "contracts/UniversalPrivacyHook.sol:UniversalPrivacyHook",
  //   });
  //   console.log("  ✅ UniversalPrivacyHook verified");
  // } catch (error: any) {
  //   if (error.message.includes("already verified")) {
  //     console.log("  ℹ️  UniversalPrivacyHook already verified");
  //   } else {
  //     console.error("  ❌ Failed to verify UniversalPrivacyHook:", error.message);
  //   }
  // }

  // // Verify DeterministicDeployFactory
  // console.log("\n4. Verifying DeterministicDeployFactory...");
  // try {
  //   await run("verify:verify", {
  //     address: contracts.DeterministicDeployFactory,
  //     constructorArguments: [],
  //     contract: "contracts/DeterministicDeployFactory.sol:DeterministicDeployFactory",
  //   });
  //   console.log("  ✅ DeterministicDeployFactory verified");
  // } catch (error: any) {
  //   if (error.message.includes("already verified")) {
  //     console.log("  ℹ️  DeterministicDeployFactory already verified");
  //   } else {
  //     console.error("  ❌ Failed to verify DeterministicDeployFactory:", error.message);
  //   }
  // }

  // Verify HybridFHERC20 (Encrypted Token)
  console.log("\n5. Verifying HybridFHERC20 (Encrypted Token)...");
  try {
    await run("verify:verify", {
      address: contracts.EncryptedToken,
      constructorArguments: ["Encrypted TOKEN", "eTOKEN"],
      contract: "contracts/HybridFHERC20.sol:HybridFHERC20",
    });
    console.log("  ✅ HybridFHERC20 verified");
  } catch (error: any) {
    if (error.message.includes("already verified")) {
      console.log("  ℹ️  HybridFHERC20 already verified");
    } else {
      console.error("  ❌ Failed to verify HybridFHERC20:", error.message);
    }
  }

  console.log("\n========================================");
  console.log("Verification Complete!");
  console.log("========================================");
  console.log("\n📝 View contracts on Etherscan:");
  console.log(`  MockUSDC: https://sepolia.etherscan.io/address/${contracts.MockUSDC}`);
  console.log(`  MockUSDT: https://sepolia.etherscan.io/address/${contracts.MockUSDT}`);
  console.log(`  Hook: https://sepolia.etherscan.io/address/${contracts.UniversalPrivacyHook}`);
  console.log(`  Factory: https://sepolia.etherscan.io/address/${contracts.DeterministicDeployFactory}`);
  console.log(`  EncryptedToken: https://sepolia.etherscan.io/address/${contracts.EncryptedToken}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });