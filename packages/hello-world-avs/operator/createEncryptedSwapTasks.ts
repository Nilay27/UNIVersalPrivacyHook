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
const UNIVERSAL_PRIVACY_HOOK = "0xf5DB4551075284285245549aa2f108fFbC9E0080";
const SWAP_MANAGER_ADDRESS = process.env.SWAP_MANAGER_ADDRESS || "0x0000000000000000000000000000000000000000"; // TODO: Deploy SwapManager on Sepolia

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
        amount: BigInt(100 * 1e18), // 100 USDC (18 decimals on test tokens)
        description: "User A: Swap 100 USDC to USDT"
    },
    {
        tokenIn: USDT_ADDRESS,
        tokenOut: USDC_ADDRESS,
        amount: BigInt(80 * 1e18), // 80 USDT (18 decimals on test tokens)
        description: "User B: Swap 80 USDT to USDC (should match with User A)"
    },
    // Another pair for partial matching
    {
        tokenIn: USDC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        amount: BigInt(50 * 1e18), // 50 USDC
        description: "User C: Swap 50 USDC to USDT"
    },
    {
        tokenIn: USDT_ADDRESS,
        tokenOut: USDC_ADDRESS,
        amount: BigInt(120 * 1e18), // 120 USDT (partial match)
        description: "User D: Swap 120 USDT to USDC (partial match with users A and C)"
    },
    // One more for net swap
    {
        tokenIn: USDC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        amount: BigInt(25 * 1e18), // 25 USDC
        description: "User E: Swap 25 USDC to USDT (might require net swap)"
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
        const feeData = await provider.getFeeData();

        // Submit the encrypted intent to UniversalPrivacyHook with handle and proof
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
                gasPrice: feeData.gasPrice
            }
        );
        
        console.log(`Transaction submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        
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

    // Note: SwapManager needs to be deployed on Sepolia for AVS to work
    if (SWAP_MANAGER_ADDRESS === "0x0000000000000000000000000000000000000000") {
        console.warn("⚠️  SwapManager not deployed on Sepolia yet.");
        console.warn("   Intents will be submitted but AVS batching won't work until SwapManager is deployed.");
    }
    
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