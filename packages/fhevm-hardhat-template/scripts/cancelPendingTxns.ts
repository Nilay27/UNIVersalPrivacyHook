import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Address:", signer.address);
  
  // Get current nonce (next nonce to be used)
  const currentNonce = await signer.getNonce();
  console.log("Current nonce:", currentNonce);
  
  // Get pending nonce (includes pending transactions)
  const pendingNonce = await signer.getNonce("pending");
  console.log("Pending nonce:", pendingNonce);
  
  if (currentNonce === pendingNonce) {
    console.log("No pending transactions found");
    return;
  }
  
  console.log(`Found ${pendingNonce - currentNonce} pending transaction(s)`);
  
  // Get current gas price and add 20% premium to replace pending txns
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = (feeData.gasPrice! * 120n) / 100n;
  console.log("Using gas price:", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  
  // Cancel each pending transaction by sending 0 ETH to self with same nonce
  for (let nonce = currentNonce; nonce < pendingNonce; nonce++) {
    console.log(`\nCancelling transaction with nonce ${nonce}...`);
    
    try {
      const tx = await signer.sendTransaction({
        to: signer.address,
        value: 0,
        nonce: nonce,
        gasLimit: 21000,
        gasPrice: gasPrice,
      });
      
      console.log(`  Tx hash: ${tx.hash}`);
      console.log("  Waiting for confirmation...");
      
      const receipt = await tx.wait();
      console.log(`  ✅ Transaction cancelled in block ${receipt?.blockNumber}`);
    } catch (error: any) {
      console.error(`  ❌ Failed to cancel nonce ${nonce}:`, error.message);
    }
  }
  
  console.log("\n✅ All pending transactions processed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });