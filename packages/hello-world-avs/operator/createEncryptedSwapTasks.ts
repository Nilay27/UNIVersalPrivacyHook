import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { initializeFhevm } from './fhevmUtils';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
const fs = require('fs');
const path = require('path');
dotenv.config();

// Setup env variables
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://sepolia.gateway.tenderly.co");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// For Sepolia
const chainId = 11155111;

// Sepolia deployment addresses
const UNIVERSAL_PRIVACY_HOOK = "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080";
const SWAP_MANAGER_ADDRESS = "0xFbce8804FfC5413d60093702664ABfd71Ce0E592";

console.log("Using UniversalPrivacyHook at:", UNIVERSAL_PRIVACY_HOOK);
console.log("Using SwapManager at:", SWAP_MANAGER_ADDRESS);

// Load UniversalPrivacyHook ABI from hardhat artifacts
let UniversalHookABI: any;
try {
    const UniversalHookArtifact = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../fhevm-hardhat-template/artifacts/contracts/UniversalPrivacyHook.sol/UniversalPrivacyHook.json'), 'utf8')
    );
    UniversalHookABI = UniversalHookArtifact.abi;
} catch (e) {
    console.error("UniversalPrivacyHook ABI not found. Please compile the contracts first.");
    console.error("Run: cd packages/fhevm-hardhat-template && npm run compile");
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

// Test swap intents - designed to create matches on Sepolia
const testIntents: SwapIntent[] = [
    // These two should match (USDC <-> USDT)
    {
        tokenIn: USDC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        amount: BigInt(5 * 1e6), // 5 USDC (6 decimals)
        description: "User A: Swap 5 USDC to USDT"
    },
    {
        tokenIn: USDT_ADDRESS,
        tokenOut: USDC_ADDRESS,
        amount: BigInt(10 * 1e6), // 10 USDT (6 decimals)
        description: "User B: Swap 10 USDT to USDC (should match with User A)"
    },
    // Another pair for partial matching
    {
        tokenIn: USDC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        amount: BigInt(5 * 1e6), // 5 USDC (6 decimals)
        description: "User C: Swap 5 USDC to USDT"
    },
    {
        tokenIn: USDT_ADDRESS,
        tokenOut: USDC_ADDRESS,
        amount: BigInt(10 * 1e6), // 10 USDT (6 decimals)
        description: "User D: Swap 10 USDT to USDC (partial match with users A and C)"
    },
    // One more for net swap
    {
        tokenIn: USDC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        amount: BigInt(2 * 1e6), // 2 USDC (6 decimals)
        description: "User E: Swap 2 USDC to USDT (might require net swap)"
    }
];

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
            setTimeout(() => reject(new Error("Transaction timeout after 60 seconds")), 60000)
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

async function main() {
    console.log("Starting Encrypted Swap Task Generator");
    console.log("=====================================\n");
    
    // Initialize ZAMA FHEVM for real FHE encryption
    console.log("Initializing ZAMA FHEVM...");

    // Initialize both the operator's FHEVM and the instance for encryption
    await initializeFhevm(wallet);
    await initializeFhevmInstance();

    console.log("ZAMA FHEVM initialized successfully");
    console.log("Real FHE encryption enabled\n");
    
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

    // SwapManager is now deployed on Sepolia
    console.log("✅ SwapManager deployed and ready for AVS batching");
    
    // Submit intents to create a batch
    console.log("\nSubmitting encrypted intents to batch...");
    const submittedIntentIds: string[] = [];
    
    for (let i = 0; i < testIntents.length; i++) {
        const intentId = await submitEncryptedIntent(universalHook, poolKey, testIntents[i]);
        if (intentId) {
            submittedIntentIds.push(intentId);
        }
        
        // Small delay between intents
        if (i < testIntents.length - 1) {
            console.log("\nWaiting 2 seconds before next intent...");
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    console.log(`\n=== All ${submittedIntentIds.length} intents submitted ===`);
    
    // Monitor for batch events from the hook
    console.log("\nBatches will auto-finalize after 5 blocks when new intents arrive.");
    console.log("Monitoring for batch events from UniversalPrivacyHook...");

    universalHook.on("BatchFinalized", (batchId: string, intentCount: number) => {
        console.log(`\n📦 Batch ${batchId} finalized with ${intentCount} intents!`);
        console.log("   Waiting for AVS operators to process and settle...");
    });

    universalHook.on("BatchSettled", (batchId: string, internalizedCount: number, netSwapCount: number) => {
        console.log(`\n✅ Batch ${batchId} settled!`);
        console.log(`   Internalized transfers: ${internalizedCount}`);
        console.log(`   Net swaps: ${netSwapCount}`);
    });
    
    // Keep the script running to monitor events
    console.log("\nPress Ctrl+C to exit...");
}

// Execute main function
main().catch((error) => {
    console.error("Error in main:", error);
    process.exit(1);
});