import { ethers } from "hardhat";
import { run } from "hardhat";

const SEPOLIA_POOL_MANAGER = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";
const BEFORE_SWAP_FLAG = 0x0080;
const EXISTING_FACTORY = "0xC43192FA7dE17d93e03a80FcaB68Ff0Cb0c358cf";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  
  // Verify deployer
  const expectedAddress = "0x0cD73A4E3d34D5488BC4E547fECeDAc86305dB9d";
  if (deployer.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    console.error(`Wrong deployer! Expected: ${expectedAddress}, Got: ${deployer.address}`);
    process.exit(1);
  }

  // Step 1: Use existing factory
  console.log("\n1. Using existing DeterministicDeployFactory...");
  const factory = await ethers.getContractAt("DeterministicDeployFactory", EXISTING_FACTORY);
  const factoryAddress = EXISTING_FACTORY;
  console.log("   ✅ Factory at:", factoryAddress);

  // Step 2: Get UniversalPrivacyHook bytecode
  const UniversalPrivacyHook = await ethers.getContractFactory("UniversalPrivacyHook");
  const bytecode = UniversalPrivacyHook.bytecode;
  
  // Encode constructor arguments
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const constructorArgs = abiCoder.encode(["address"], [SEPOLIA_POOL_MANAGER]);
  const initCode = bytecode + constructorArgs.slice(2);
  const initCodeHash = ethers.keccak256(initCode);

  console.log("\n2. Mining address with ONLY beforeSwap permission (0x0080)...");
  
  let salt = 0n;
  let hookAddress = "";
  let attempts = 0;
  const maxAttempts = 1000000;

  while (attempts < maxAttempts) {
    salt = BigInt(attempts);
    
    // Calculate CREATE2 address using our factory
    const create2Address = ethers.getCreate2Address(
      factoryAddress,
      ethers.toBeHex(salt, 32),
      initCodeHash
    );
    
    // Check if last 2 bytes have ONLY the required permission bit
    const addressBits = BigInt(create2Address) & BigInt(0xFFFF);
    
    // We need EXACTLY 0x0080 (only beforeSwap, nothing else)
    if (addressBits === BigInt(BEFORE_SWAP_FLAG)) {
      hookAddress = create2Address;
      console.log(`\n   ✅ Found valid address after ${attempts} attempts!`);
      console.log(`   Hook address: ${hookAddress}`);
      console.log(`   Salt: ${salt}`);
      console.log(`   Last 2 bytes: 0x${create2Address.slice(-4)}`);
      break;
    }

    attempts++;
    if (attempts % 100000 === 0) {
      console.log(`   Tried ${attempts} salts...`);
    }
  }

  if (!hookAddress) {
    console.error("Could not find address with required permission bits");
    process.exit(1);
  }

  // Step 3: Deploy UniversalPrivacyHook using our factory
  console.log("\n3. Deploying UniversalPrivacyHook via our factory...");
  
  try {
    const gasPrice = await ethers.provider.getFeeData();
    const gasPriceWithBuffer = (gasPrice.gasPrice! * 120n) / 100n;
    
    console.log("   Current gas price:", ethers.formatUnits(gasPrice.gasPrice!, "gwei"), "gwei");
    console.log("   Using gas price:", ethers.formatUnits(gasPriceWithBuffer, "gwei"), "gwei");
    console.log("   Sending deployment transaction...");
    
    const tx = await factory.deploy(initCode, salt, {
      gasLimit: 10000000,
      gasPrice: gasPriceWithBuffer,
    });
    
    console.log(`   Transaction hash: ${tx.hash}`);
    console.log("   Waiting for confirmation...");
    
    const receipt = await tx.wait(2);
    console.log(`   ✅ Contract deployed in block ${receipt.blockNumber}`);
    
    // Verify the deployed address matches
    console.log(`\n   Expected address: ${hookAddress}`);
    
    // Check if contract has code
    const code = await ethers.provider.getCode(hookAddress);
    if (code === "0x" || code === "0x00") {
      console.error("   ❌ No code at deployed address! Constructor may have reverted.");
    } else {
      console.log("   ✅ Contract code verified at address");
      console.log("   Code length:", code.length, "characters");
    }
    
    // Extract the deployed address from events
    const deployEvent = receipt.logs.find(
      (log: any) => log.address.toLowerCase() === factoryAddress.toLowerCase()
    );
    if (deployEvent) {
      const iface = new ethers.Interface(["event Deploy(address addr)"]);
      const parsed = iface.parseLog(deployEvent);
      console.log(`   Event confirmed deployment at: ${parsed?.args[0]}`);
    }
    
    console.log("\n========================================");
    console.log("✅ UniversalPrivacyHook Successfully Deployed!");
    console.log("========================================");
    console.log(`   Network: Sepolia`);
    console.log(`   Hook address: ${hookAddress}`);
    console.log(`   Pool Manager: ${SEPOLIA_POOL_MANAGER}`);
    console.log(`   Factory: ${factoryAddress}`);
    console.log(`   Salt: ${salt}`);
    console.log(`   Permission bits: 0x0080 (beforeSwap only)`);
    console.log(`   Transaction: https://sepolia.etherscan.io/tx/${tx.hash}`);
    
    // Step 4: Verify the hook on Etherscan
    console.log("\n4. Verifying UniversalPrivacyHook on Etherscan...");
    console.log("   Waiting a bit for Etherscan to index the contract...");
    await new Promise(resolve => setTimeout(resolve, 45000)); // Wait 60 seconds
    console.log("Waiting 45 seconds")
    
    try {
      await run("verify:verify", {
        address: hookAddress,
        constructorArguments: [SEPOLIA_POOL_MANAGER],
        contract: "contracts/UniversalPrivacyHook.sol:UniversalPrivacyHook",
      });
      console.log("   ✅ UniversalPrivacyHook verified on Etherscan!");
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log("   ℹ️  UniversalPrivacyHook already verified");
      } else {
        console.error("   ⚠️  Failed to verify (can verify manually later):", error.message);
      }
    }
    
    console.log("\n========================================");
    console.log("📝 Summary");
    console.log("========================================");
    console.log(`Hook Address: ${hookAddress}`);
    console.log(`View on Etherscan: https://sepolia.etherscan.io/address/${hookAddress}`);
    console.log("\n⚠️  IMPORTANT: Update the hook address in:");
    console.log("   - scripts/setupPool.ts");
    console.log("   - scripts/testDeposit.ts");
    console.log("   - scripts/testSubmitIntent.ts");
    console.log("   - Any frontend configuration");
    
  } catch (error: any) {
    console.error("\n❌ Deployment failed:", error.message);
    process.exit(1);
  }

  // try {
  //     await run("verify:verify", {
  //       address: hookAddress,
  //       constructorArguments: [SEPOLIA_POOL_MANAGER],
  //       contract: "contracts/UniversalPrivacyHook.sol:UniversalPrivacyHook",
  //     });
  //     console.log("   ✅ UniversalPrivacyHook verified on Etherscan!");
  //   } catch (error: any) {
  //     if (error.message.includes("already verified")) {
  //       console.log("   ℹ️  UniversalPrivacyHook already verified");
  //     } else {
  //       console.error("   ⚠️  Failed to verify (can verify manually later):", error.message);
  //     }
  //   }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });