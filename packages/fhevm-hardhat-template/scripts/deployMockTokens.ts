import { ethers } from "hardhat";
import { run } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Mock tokens with account:", deployer.address);
  
  // Verify deployer
  const expectedAddress = "0x0cD73A4E3d34D5488BC4E547fECeDAc86305dB9d";
  if (deployer.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    console.error(`Wrong deployer! Expected: ${expectedAddress}, Got: ${deployer.address}`);
    process.exit(1);
  }

  console.log("\n========================================");
  console.log("Deploying Mock ERC20 Tokens on Sepolia");
  console.log("========================================\n");

  // Deploy MockUSDC
  console.log("1. Deploying MockUSDC...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
  await mockUSDC.waitForDeployment();
  const usdcAddress = await mockUSDC.getAddress();
  console.log("   ✅ MockUSDC deployed at:", usdcAddress);

  // Deploy MockUSDT
  console.log("\n2. Deploying MockUSDT...");
  const mockUSDT = await MockERC20.deploy("Tether USD", "USDT", 6);
  await mockUSDT.waitForDeployment();
  const usdtAddress = await mockUSDT.getAddress();
  console.log("   ✅ MockUSDT deployed at:", usdtAddress);

  // Mint some tokens for testing
  console.log("\n3. Minting tokens for testing...");
  const mintAmount = ethers.parseUnits("1000000", 6); // 1M tokens
  await mockUSDC.mint(deployer.address, mintAmount);
  await mockUSDT.mint(deployer.address, mintAmount);
  console.log("   ✅ Minted 1M USDC and 1M USDT to deployer");

  // Wait a bit before verification
  console.log("\n4. Waiting for block confirmations before verification...");
  await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds

  // Verify MockUSDC
  console.log("\n5. Verifying MockUSDC...");
  try {
    await run("verify:verify", {
      address: usdcAddress,
      constructorArguments: ["USD Coin", "USDC", 6],
      contract: "contracts/test/MockERC20.sol:MockERC20",
    });
    console.log("   ✅ MockUSDC verified");
  } catch (error: any) {
    if (error.message.includes("already verified")) {
      console.log("   ℹ️  MockUSDC already verified");
    } else {
      console.error("   ❌ Failed to verify MockUSDC:", error.message);
    }
  }

  // Verify MockUSDT
  console.log("\n6. Verifying MockUSDT...");
  try {
    await run("verify:verify", {
      address: usdtAddress,
      constructorArguments: ["Tether USD", "USDT", 6],
      contract: "contracts/test/MockERC20.sol:MockERC20",
    });
    console.log("   ✅ MockUSDT verified");
  } catch (error: any) {
    if (error.message.includes("already verified")) {
      console.log("   ℹ️  MockUSDT already verified");
    } else {
      console.error("   ❌ Failed to verify MockUSDT:", error.message);
    }
  }

  console.log("\n========================================");
  console.log("Deployment Complete!");
  console.log("========================================");
  console.log("\n📋 Summary:");
  console.log("   MockUSDC:", usdcAddress);
  console.log("   MockUSDT:", usdtAddress);
  console.log("\n📝 View on Etherscan:");
  console.log(`   USDC: https://sepolia.etherscan.io/address/${usdcAddress}`);
  console.log(`   USDT: https://sepolia.etherscan.io/address/${usdtAddress}`);
  
  console.log("\n⚠️  IMPORTANT: Update setupPool.ts with these new addresses!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });