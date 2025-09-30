import { ethers } from "ethers";
import * as dotenv from "dotenv";
const fs = require('fs');
const path = require('path');
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// Contract addresses
const UNIVERSAL_PRIVACY_HOOK = "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080";
const SWAP_MANAGER_ADDRESS = "0x9DbA075FAD6be58cf0De872d53EC52bB79a7c461";
const USDC_ADDRESS = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
const USDT_ADDRESS = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";

// Load UniversalPrivacyHook ABI
let UniversalHookABI: any;
try {
    const UniversalHookArtifact = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../fhevm-hardhat-template/artifacts/contracts/UniversalPrivacyHook.sol/UniversalPrivacyHook.json'), 'utf8')
    );
    UniversalHookABI = UniversalHookArtifact.abi;
} catch (e) {
    console.error("UniversalPrivacyHook ABI not found. Please compile the contracts first.");
    process.exit(1);
}

async function checkBatchStatus() {
    console.log("=== Checking Batch Status ===\n");

    const hook = new ethers.Contract(UNIVERSAL_PRIVACY_HOOK, UniversalHookABI, wallet);

    // Create pool key
    const [currency0, currency1] = USDC_ADDRESS.toLowerCase() < USDT_ADDRESS.toLowerCase()
        ? [USDC_ADDRESS, USDT_ADDRESS]
        : [USDT_ADDRESS, USDC_ADDRESS];

    const poolKey = {
        currency0: currency0,
        currency1: currency1,
        fee: 3000,
        tickSpacing: 60,
        hooks: UNIVERSAL_PRIVACY_HOOK
    };

    // Get pool ID (need to compute it the same way the contract does)
    const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    ));

    console.log("Pool ID:", poolId);

    try {
        // Get current batch ID
        const currentBatchId = await hook.currentBatchId(poolId);
        console.log("Current Batch ID:", currentBatchId);

        if (currentBatchId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
            // Get batch details - returns as tuple
            const batchData = await hook.batches(currentBatchId);

            // Destructure the batch tuple
            const batch = {
                intentIds: batchData[0] || [],
                createdBlock: batchData[1],
                submittedBlock: batchData[2],
                finalized: batchData[3],
                settled: batchData[4]
            };

            console.log("\nBatch Details:");
            console.log("  Intent IDs:", batch.intentIds);
            console.log("  Number of Intents:", batch.intentIds.length);
            console.log("  Created Block:", batch.createdBlock.toString());
            console.log("  Submitted Block:", batch.submittedBlock.toString());
            console.log("  Finalized:", batch.finalized);
            console.log("  Settled:", batch.settled);

            // Get current block number
            const currentBlock = await provider.getBlockNumber();
            console.log("\nCurrent Block:", currentBlock);

            const BATCH_INTERVAL = 5;
            const blocksUntilFinalize = Number(batch.createdBlock) + BATCH_INTERVAL - currentBlock;
            console.log(`Blocks until auto-finalize: ${blocksUntilFinalize} (${blocksUntilFinalize > 0 ? blocksUntilFinalize : "ready to finalize"})`);

            // Check each intent in the batch
            if (batch.intentIds.length > 0) {
                console.log("\nIntent Details:");
                for (let i = 0; i < batch.intentIds.length; i++) {
                    const intentId = batch.intentIds[i];
                    const intent = await hook.intents(intentId);
                    console.log(`\nIntent ${i + 1} (${intentId.slice(0, 10)}...):`);
                    console.log("  User:", intent.user);
                    console.log("  Token In:", intent.tokenIn);
                    console.log("  Token Out:", intent.tokenOut);
                    console.log("  Encrypted Amount:", intent.encryptedAmount);
                    console.log("  Deadline:", new Date(Number(intent.deadline) * 1000).toLocaleString());
                    console.log("  Processed:", intent.processed);
                    console.log("  Batch ID:", intent.batchId);
                }
            }
        } else {
            console.log("No active batch for this pool");
        }

    } catch (error: any) {
        console.error("Error checking batch status:", error.message);
        if (error.data) {
            console.error("Error data:", error.data);
        }
    }
}

checkBatchStatus().catch(console.error);