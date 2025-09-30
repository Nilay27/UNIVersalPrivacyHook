import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { initializeFhevm } from './fhevmUtils';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
const fs = require('fs');
const path = require('path');
dotenv.config();

// Setup env variables
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://sepolia.gateway.tenderly.co");
const wallet = new ethers.Wallet(process.env.HELPER_WALLET_KEY!, provider);

// For Sepolia
const chainId = 11155111;

// Sepolia deployment addresses
const UNIVERSAL_PRIVACY_HOOK = "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080";
const SWAP_MANAGER_ADDRESS = "0xFbce8804FfC5413d60093702664ABfd71Ce0E592";

console.log("Using UniversalPrivacyHook at:", UNIVERSAL_PRIVACY_HOOK);
console.log("Using SwapManager at:", SWAP_MANAGER_ADDRESS);

// Load UniversalPrivacyHook ABI from abis folder
let UniversalHookABI: any;
try {
    UniversalHookABI = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../abis/UniversalPrivacyHook.json'), 'utf8')
    );
} catch (e) {
    console.error("UniversalPrivacyHook ABI not found at abis/UniversalPrivacyHook.json");
    console.error(e);
    process.exit(1);
}

// Sepolia token addresses
const USDC_ADDRESS = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
const USDT_ADDRESS = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";

interface SwapIntent {
    tokenIn: string;
    tokenOut: string;
    amount: bigint;
    description: string;
}

// Initialize FHEVM instance globally
let fhevmInstance: any = null;

async function initializeFhevmInstance() {
    if (!fhevmInstance) {
        // Create FHEVM instance for Sepolia
        const networkUrl = process.env.RPC_URL || "https://sepolia.gateway.tenderly.co";
        console.log("Creating FHEVM instance with network:", networkUrl);

        fhevmInstance = await createInstance({
            ...SepoliaConfig,
            network: networkUrl
        });

        console.log("FHEVM instance created successfully");
    }
    return fhevmInstance;
}

async function encryptAmountForIntent(amount: bigint, contractAddress: string, signerAddress: string): Promise<{ handle: any; inputProof: any }> {
    try {
        console.log(`Encrypting amount using ZAMA FHEVM: ${amount}`);

        // Use the initialized FHEVM instance
        const fhevm = await initializeFhevmInstance();

        const encryptedInput = fhevm
            .createEncryptedInput(contractAddress, signerAddress)
            .add128(amount);

        const encrypted = await encryptedInput.encrypt();

        console.log("Encrypted amount handle:", encrypted.handles[0]);
        console.log("Input proof length:", encrypted.inputProof.length, "bytes");

        return {
            handle: encrypted.handles[0],
            inputProof: encrypted.inputProof
        };
    } catch (error) {
        console.error("Error encrypting amount:", error);
        throw error;
    }
}

async function submitEncryptedIntent(
    universalHook: ethers.Contract,
    poolKey: any,
    intent: SwapIntent
): Promise<string | null> {
    console.log(`\n=== Submitting Encrypted Intent ===`);
    console.log(`Description: ${intent.description}`);
    console.log(`Token In: ${intent.tokenIn}`);
    console.log(`Token Out: ${intent.tokenOut}`);
    console.log(`Amount: ${intent.amount.toString()}`);
    
    try {
        // Encrypt the amount using ZAMA FHEVM with proper proof
        const encrypted = await encryptAmountForIntent(
            intent.amount,
            UNIVERSAL_PRIVACY_HOOK,
            wallet.address
        );

        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

        // Get current nonce and gas price to avoid estimation issues
        const nonce = await wallet.getNonce();
        console.log(`Using nonce: ${nonce}`);

        const feeData = await provider.getFeeData();
        const gasPrice = (feeData.gasPrice! * 120n) / 100n;
        console.log(`Gas price: ${gasPrice.toString()}`);

        console.log("Submitting transaction to UniversalPrivacyHook...");
        console.log("Contract address:", universalHook.target);
        console.log("Wallet address:", wallet.address);

        // Try to estimate gas first
        try {
            console.log("Estimating gas...");
            console.log("Parameters being sent:");
            console.log("  poolKey:", JSON.stringify(poolKey, null, 2));
            console.log("  tokenIn:", intent.tokenIn);
            console.log("  tokenOut:", intent.tokenOut);
            console.log("  encryptedHandle:", encrypted.handle);
            console.log("  inputProof length:", encrypted.inputProof.length);
            console.log("  deadline:", deadline);

            // Try to decode the revert reason if gas estimation fails
            const estimatedGas = await universalHook.submitIntent.estimateGas(
                poolKey,
                intent.tokenIn,
                intent.tokenOut,
                encrypted.handle,
                encrypted.inputProof,
                deadline
            );
            console.log(`Estimated gas: ${estimatedGas.toString()}`);
        } catch (estimateError: any) {
            console.error("Gas estimation failed:", estimateError.message);

            // Try to get more details about the error
            if (estimateError.data) {
                try {
                    const decodedError = universalHook.interface.parseError(estimateError.data);
                    console.error("Decoded error:", decodedError);
                } catch {
                    console.error("Raw error data:", estimateError.data);
                }
            }

            if (estimateError.reason) {
                console.error("Revert reason:", estimateError.reason);
            }

            console.error("Full error object:", JSON.stringify(estimateError, null, 2));
            // Continue anyway with manual gas limit
        }

        // Submit the encrypted intent to UniversalPrivacyHook with handle and proof
        console.log("Attempting to send transaction...");
        const tx = await universalHook.submitIntent(
            poolKey,
            intent.tokenIn,
            intent.tokenOut,
            encrypted.handle,
            encrypted.inputProof,
            deadline,
            {
                nonce: nonce,
                gasLimit: 5000000,
                gasPrice: gasPrice
            }
        );

        console.log(`Transaction submitted: ${tx.hash}`);
        console.log("Waiting for confirmation (this may take 15-30 seconds)...");

        // Add timeout for transaction confirmation
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Transaction timeout after 2 minutes")), 120000)
        );

        const receipt = await Promise.race([
            tx.wait(1), // Wait for 1 confirmation
            timeoutPromise
        ]) as any;
        console.log("transaction receipt with hash:", receipt.hash);
        // Parse events from the receipt
        const intentSubmittedEvent = receipt.logs.find((log: any) => {
            try {
                const parsed = universalHook.interface.parseLog(log);
                return parsed?.name === "IntentSubmitted";
            } catch {
                return false;
            }
        });
        
        if (intentSubmittedEvent) {
            const intentParsed = universalHook.interface.parseLog(intentSubmittedEvent);
            const intentId = intentParsed?.args.intentId;
            
            console.log(`✅ Intent submitted successfully!`);
            console.log(`   Intent ID: ${intentId}`);
            
            return intentId;
        }
        
        return null;
    } catch (error) {
        console.error(`❌ Error submitting intent:`, error);
        return null;
    }
}

// Track last processed block to avoid duplicate submissions
let lastProcessedBlock = 0;
let isProcessingIntent = false;

async function submitHelperCounterIntent(
    universalHook: ethers.Contract,
    poolKey: any,
    userTokenIn: string,
    userTokenOut: string
): Promise<void> {
    if (isProcessingIntent) {
        console.log("Already processing an intent, skipping...");
        return;
    }

    isProcessingIntent = true;

    try {
        // Submit 1 token in opposite direction
        const helperIntent: SwapIntent = {
            tokenIn: userTokenOut,  // Opposite direction
            tokenOut: userTokenIn,  // Opposite direction
            amount: BigInt(1 * 1e6), // Fixed 1 token (6 decimals)
            description: "Helper counter-intent (1 token)"
        };

        console.log("\n🤖 Auto-submitting helper counter-intent (1 token in opposite direction)...");
        const intentId = await submitEncryptedIntent(universalHook, poolKey, helperIntent);

        if (intentId) {
            console.log(`✅ Helper counter-intent submitted: ${intentId}`);

            // Wait ~48 seconds (4 blocks) then submit finalization trigger
            console.log("⏰ Scheduling finalization trigger in 48 seconds...");
            setTimeout(async () => {
                await submitFinalizationTrigger(universalHook, poolKey);
            }, 48000);
        }
    } catch (error) {
        console.error("❌ Error submitting helper intent:", error);
    } finally {
        isProcessingIntent = false;
    }
}

async function submitFinalizationTrigger(
    universalHook: ethers.Contract,
    poolKey: any
): Promise<void> {
    try {
        console.log("\n🎯 Submitting finalization trigger (tiny intent to force batch processing)...");

        const tinyIntent: SwapIntent = {
            tokenIn: USDC_ADDRESS,
            tokenOut: USDT_ADDRESS,
            amount: BigInt(200), // 200 wei to avoid Uniswap minimum swap revert
            description: "Finalization trigger"
        };

        const intentId = await submitEncryptedIntent(universalHook, poolKey, tinyIntent);
        if (intentId) {
            console.log(`✅ Finalization trigger submitted: ${intentId}`);
            console.log("📦 Batch should finalize and settle within 1-2 minutes!");
        }
    } catch (error) {
        console.error("❌ Error submitting finalization trigger:", error);
    }
}

async function main() {
    console.log("🚀 Starting Helper Intent Auto-Submission Service");
    console.log("===================================================\n");

    // Initialize ZAMA FHEVM for real FHE encryption
    console.log("Initializing ZAMA FHEVM...");

    // Initialize both the operator's FHEVM and the instance for encryption
    await initializeFhevm(wallet);
    await initializeFhevmInstance();

    console.log("✅ ZAMA FHEVM initialized successfully");
    console.log("✅ Real FHE encryption enabled\n");

    // Initialize UniversalPrivacyHook contract
    const universalHook = new ethers.Contract(UNIVERSAL_PRIVACY_HOOK, UniversalHookABI, wallet);

    // Create PoolKey for the USDC/USDT pool
    // Order tokens correctly (lower address first)
    const [currency0, currency1] = USDC_ADDRESS.toLowerCase() < USDT_ADDRESS.toLowerCase()
        ? [USDC_ADDRESS, USDT_ADDRESS]
        : [USDT_ADDRESS, USDC_ADDRESS];

    const poolKey = {
        currency0: currency0,
        currency1: currency1,
        fee: 3000, // 0.3% fee
        tickSpacing: 60,
        hooks: UNIVERSAL_PRIVACY_HOOK
    };

    console.log("Pool Key:", poolKey);
    console.log("Helper Wallet:", wallet.address);
    console.log("\n📡 Monitoring for IntentSubmitted events...");
    console.log("🤖 Will auto-submit 1 token counter-intent for each user swap");
    console.log("⏰ Will auto-trigger batch finalization 60s after counter-intent\n");

    // Get current block to start monitoring from
    lastProcessedBlock = await provider.getBlockNumber();
    console.log(`Starting from block: ${lastProcessedBlock}\n`);

    // Poll for new intents every 12 seconds (1 block time on Sepolia)
    const pollInterval = 12000; // 12 seconds

    async function pollForNewIntents() {
        try {
            const currentBlock = await provider.getBlockNumber();

            // Ensure we don't query backwards
            if (currentBlock <= lastProcessedBlock) {
                return;
            }

            console.log(`📡 Polling blocks ${lastProcessedBlock + 1} to ${currentBlock}...`);

            // Query for IntentSubmitted events in the new blocks
            const filter = universalHook.filters.IntentSubmitted();
            const events = await universalHook.queryFilter(filter, lastProcessedBlock + 1, currentBlock);

            console.log(`   Found ${events.length} IntentSubmitted events`);

            for (const log of events) {
                // Cast to EventLog to access args
                const event = log as ethers.EventLog;
                if (!event.args) continue;

                const { tokenIn, tokenOut, user, intentId } = event.args;
                const blockNumber = event.blockNumber;

                // Skip if it's our helper wallet
                if (user.toLowerCase() === wallet.address.toLowerCase()) {
                    continue;
                }

                console.log(`\n🔔 New intent detected from user: ${user.substring(0, 8)}...`);
                console.log(`   Token In: ${tokenIn === USDC_ADDRESS ? 'USDC' : 'USDT'}`);
                console.log(`   Token Out: ${tokenOut === USDC_ADDRESS ? 'USDC' : 'USDT'}`);
                console.log(`   Intent ID: ${intentId}`);
                console.log(`   Block: ${blockNumber}`);

                // Submit helper counter-intent
                await submitHelperCounterIntent(universalHook, poolKey, tokenIn, tokenOut);
            }

            // Check for batch events too
            const batchFinalizedFilter = universalHook.filters.BatchFinalized();
            const batchFinalizedEvents = await universalHook.queryFilter(batchFinalizedFilter, lastProcessedBlock + 1, currentBlock);

            for (const log of batchFinalizedEvents) {
                const event = log as ethers.EventLog;
                if (!event.args) continue;
                const { batchId, intentCount } = event.args;
                console.log(`\n📦 Batch ${batchId} finalized with ${intentCount} intents!`);
                console.log("   Waiting for AVS operator to decrypt and settle...");
            }

            const batchSettledFilter = universalHook.filters.BatchSettled();
            const batchSettledEvents = await universalHook.queryFilter(batchSettledFilter, lastProcessedBlock + 1, currentBlock);

            for (const log of batchSettledEvents) {
                const event = log as ethers.EventLog;
                if (!event.args) continue;
                const { batchId, internalizedCount, netSwapCount } = event.args;
                console.log(`\n✅ Batch ${batchId} settled!`);
                console.log(`   Internalized transfers: ${internalizedCount}`);
                console.log(`   Net swaps: ${netSwapCount}`);
            }

            lastProcessedBlock = currentBlock;
        } catch (error: any) {
            console.error("Error polling for events:", error.message || error);
            // If we get a block range error, reset to current block
            if (error.message?.includes('block range') || error.message?.includes('end') || error.message?.includes('begin')) {
                const currentBlock = await provider.getBlockNumber();
                lastProcessedBlock = currentBlock;
                console.log(`Reset to current block: ${currentBlock}`);
            }
        }
    }

    // Start polling
    setInterval(pollForNewIntents, pollInterval);

    // Keep the script running
    console.log("✅ Service running with 12s polling... Press Ctrl+C to exit\n");
}

// Execute main function
main().catch((error) => {
    console.error("Error in main:", error);
    process.exit(1);
});