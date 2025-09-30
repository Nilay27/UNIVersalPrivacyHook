import { ethers } from "ethers";
import * as dotenv from "dotenv";
const fs = require('fs');
const path = require('path');
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// Contract addresses
const UNIVERSAL_PRIVACY_HOOK = "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080";

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

async function checkBatchEvents() {
    console.log("=== Checking Batch Events ===\n");

    const hook = new ethers.Contract(UNIVERSAL_PRIVACY_HOOK, UniversalHookABI, provider);

    try {
        // Get recent events
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = currentBlock - 5000; // Look back 5000 blocks

        console.log(`Checking events from block ${fromBlock} to ${currentBlock}\n`);

        // Check for IntentSubmitted events
        const intentFilter = hook.filters.IntentSubmitted();
        const intentEvents = await hook.queryFilter(intentFilter, fromBlock, currentBlock);

        console.log(`Found ${intentEvents.length} IntentSubmitted events:`);
        for (const event of intentEvents) {
            const args = (event as any).args;
            console.log(`\nBlock ${event.blockNumber}, Tx: ${event.transactionHash.slice(0, 10)}...`);
            console.log(`  Intent ID: ${args.intentId}`);
            console.log(`  User: ${args.user}`);
            console.log(`  Token In: ${args.tokenIn}`);
            console.log(`  Token Out: ${args.tokenOut}`);
            console.log(`  Deadline: ${new Date(Number(args.deadline) * 1000).toLocaleString()}`);
        }

        console.log("\n" + "=".repeat(60) + "\n");

        // Check for BatchCreated events
        const batchCreatedFilter = hook.filters.BatchCreated();
        const batchCreatedEvents = await hook.queryFilter(batchCreatedFilter, fromBlock, currentBlock);

        console.log(`Found ${batchCreatedEvents.length} BatchCreated events:`);
        for (const event of batchCreatedEvents) {
            const args = (event as any).args;
            console.log(`\nBlock ${event.blockNumber}, Tx: ${event.transactionHash.slice(0, 10)}...`);
            console.log(`  Batch ID: ${args.batchId}`);
            console.log(`  Pool ID: ${args.poolId}`);
            console.log(`  Intent Count: ${args.intentCount}`);
        }

        console.log("\n" + "=".repeat(60) + "\n");

        // Check for BatchFinalized events
        const batchFinalizedFilter = hook.filters.BatchFinalized();
        const batchFinalizedEvents = await hook.queryFilter(batchFinalizedFilter, fromBlock, currentBlock);

        console.log(`Found ${batchFinalizedEvents.length} BatchFinalized events:`);
        for (const event of batchFinalizedEvents) {
            const args = (event as any).args;
            console.log(`\nBlock ${event.blockNumber}, Tx: ${event.transactionHash.slice(0, 10)}...`);
            console.log(`  Batch ID: ${args.batchId}`);
            console.log(`  Intent Count: ${args.intentCount}`);
        }

        console.log("\n" + "=".repeat(60) + "\n");

        // Check for BatchSettled events
        const batchSettledFilter = hook.filters.BatchSettled();
        const batchSettledEvents = await hook.queryFilter(batchSettledFilter, fromBlock, currentBlock);

        console.log(`Found ${batchSettledEvents.length} BatchSettled events:`);
        for (const event of batchSettledEvents) {
            const args = (event as any).args;
            console.log(`\nBlock ${event.blockNumber}, Tx: ${event.transactionHash.slice(0, 10)}...`);
            console.log(`  Batch ID: ${args.batchId}`);
        }

    } catch (error: any) {
        console.error("Error checking events:", error.message);
    }
}

checkBatchEvents().catch(console.error);