import { ethers } from "hardhat";
import { deployHookWithMining, Hooks } from "./hookUtils";

async function main() {
  console.log("Deploying UniversalPrivacyHook...");

  // First, we need to deploy the PoolManager
  // In a real deployment, this would already exist on mainnet/testnet
  const PoolManager = await ethers.getContractFactory("PoolManager");
  const poolManager = await PoolManager.deploy(500000); // Initial unlock price
  await poolManager.waitForDeployment();
  const poolManagerAddress = await poolManager.getAddress();
  console.log("PoolManager deployed to:", poolManagerAddress);

  // Define the hook permissions we need
  // UniversalPrivacyHook needs BEFORE_SWAP permission to process intents
  const hookFlags = Hooks.BEFORE_SWAP_FLAG;

  // Deploy the hook with address mining
  const hook = await deployHookWithMining(
    "UniversalPrivacyHook",
    poolManagerAddress,
    hookFlags,
    0x00 // Prefix for hook address
  );

  console.log("UniversalPrivacyHook deployed successfully!");
  console.log("Hook address:", await hook.getAddress());
  
  // Verify the hook has the correct permissions
  const permissions = await hook.getHookPermissions();
  console.log("Hook permissions:", permissions);

  // Save deployment addresses for frontend
  const fs = require("fs");
  const deploymentInfo = {
    poolManager: poolManagerAddress,
    universalPrivacyHook: await hook.getAddress(),
    network: (await ethers.provider.getNetwork()).name,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(
    "./deployments/universalPrivacyHook.json",
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\nDeployment info saved to ./deployments/universalPrivacyHook.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });