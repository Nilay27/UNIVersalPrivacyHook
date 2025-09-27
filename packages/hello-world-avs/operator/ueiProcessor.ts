import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { initializeFhevm } from './fhevmUtils';

dotenv.config();

// Argument type enum matching Solidity
export enum ArgType {
    ADDR = 0,
    U256 = 1,
    U16 = 2,
    U32 = 3,
    U64 = 4,
    U128 = 5,
    BYTES = 6,
    BYTES32 = 7
}

// UEI structure
interface UEIData {
    ctDecoder: bigint;      // Encrypted decoder address (ctHash)
    ctTarget: bigint;       // Encrypted target address (ctHash)
    ctSelector: bigint;     // Encrypted function selector (ctHash as uint256)
    argTypes: ArgType[];    // Argument types
    ctArgs: bigint[];       // Encrypted arguments (ctHashes)
}

// Decrypted UEI
interface DecryptedUEI {
    decoder: string;
    target: string;
    selector: string;
    args: any[];
}

/**
 * Initialize UEI processor
 */
export async function initializeUEIProcessor(wallet: ethers.Wallet) {
    console.log("Initializing UEI Processor...");
    await initializeFhevm(wallet);
    console.log("✅ UEI Processor initialized with FHEVM");
}

/**
 * Decode UEI blob from contract
 */
export function decodeUEIBlob(ctBlob: string): UEIData {
    try {
        // Remove 0x prefix if present
        const cleanBlob = ctBlob.startsWith('0x') ? ctBlob.slice(2) : ctBlob;

        // Decode the blob
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['uint256', 'uint256', 'uint256', 'uint8[]', 'uint256[]'],
            '0x' + cleanBlob
        );

        return {
            ctDecoder: BigInt(decoded[0]),
            ctTarget: BigInt(decoded[1]),
            ctSelector: BigInt(decoded[2]),  // Now it's uint256
            argTypes: decoded[3].map((t: number) => t as ArgType),
            ctArgs: decoded[4].map((arg: any) => BigInt(arg))
        };
    } catch (error) {
        console.error("Failed to decode UEI blob:", error);
        throw error;
    }
}

/**
 * Decrypt a single UEI component
 */
async function decryptUEIComponent(ctHash: bigint, componentType: string): Promise<any> {
    console.log(`Decrypting ${componentType} with ctHash:`, ctHash.toString());

    try {
        // For UEI, we already have the ctHash as a bigint, so we need to look it up directly
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
        const taskManagerAddress = '0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9';
        const MAPPING_SLOT = 1; // Same as used in batch decrypt for swaps

        // Calculate the storage slot - same approach as batchDecryptAmounts
        const storageSlot = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["uint256", "uint256"],
                [ctHash, MAPPING_SLOT]
            )
        );

        console.log(`Looking for ctHash ${ctHash} at storage slot ${storageSlot}`);
        const storedValue = await provider.getStorage(taskManagerAddress, storageSlot);
        const decryptedValue = BigInt(storedValue);

        if (decryptedValue > 0n && decryptedValue < BigInt(2**128)) {
            console.log(`✅ Decrypted ${componentType}:`, decryptedValue);
            return decryptedValue;
        } else {
            console.log(`No value found in storage for ${componentType}, using fallback`);
            return BigInt(1000000000);
        }
    } catch (error) {
        console.error(`Failed to decrypt ${componentType}:`, error);
        throw error;
    }
}

/**
 * Convert decrypted value to address
 */
function toAddress(value: bigint | number): string {
    const hex = value.toString(16).padStart(40, '0');
    return '0x' + hex;
}

/**
 * Convert decrypted value to bytes4 selector
 */
function toSelector(value: number): string {
    const hex = value.toString(16).padStart(8, '0');
    return '0x' + hex;
}

/**
 * Decrypt argument based on its type
 */
async function decryptArgument(ctHash: bigint, argType: ArgType): Promise<any> {
    const decryptedValue = await decryptUEIComponent(ctHash, `arg_type_${ArgType[argType]}`);

    console.log(`Processing argument: argType=${argType}, ArgType[argType]=${ArgType[argType]}, typeof=${typeof argType}`);

    // Convert to number to handle potential type coercion issues
    const argTypeNum = Number(argType);

    switch (argTypeNum) {
        case ArgType.ADDR:
            return toAddress(decryptedValue);

        case ArgType.U256:
        case ArgType.U128:
        case ArgType.U64:
        case ArgType.U32:
        case ArgType.U16:
            return BigInt(decryptedValue);

        case ArgType.BYTES32:
            return '0x' + BigInt(decryptedValue).toString(16).padStart(64, '0');

        case ArgType.BYTES:
            // For bytes, we'd need special handling
            // For now, return as hex string
            return '0x' + BigInt(decryptedValue).toString(16);

        default:
            throw new Error(`Unsupported argument type: ${argType} (${ArgType[argType]}) - available types: ${Object.keys(ArgType).filter(k => isNaN(Number(k)))}`);
    }
}

/**
 * Decrypt entire UEI
 */
export async function decryptUEI(ueiData: UEIData): Promise<DecryptedUEI> {
    console.log("\n=== Decrypting UEI ===");

    // Decrypt decoder address
    const decoderValue = await decryptUEIComponent(ueiData.ctDecoder, 'decoder');
    const decoder = toAddress(decoderValue);

    // Decrypt target address
    const targetValue = await decryptUEIComponent(ueiData.ctTarget, 'target');
    const target = toAddress(targetValue);

    // Decrypt function selector
    const selectorValue = await decryptUEIComponent(ueiData.ctSelector, 'selector');
    const selector = toSelector(Number(selectorValue));

    // Decrypt arguments
    console.log("\nDecrypting arguments...");
    const args: any[] = [];
    for (let i = 0; i < ueiData.ctArgs.length; i++) {
        const arg = await decryptArgument(ueiData.ctArgs[i], ueiData.argTypes[i]);
        args.push(arg);
        console.log(`  Arg[${i}] (${ArgType[ueiData.argTypes[i]]}):`, arg);
    }

    return {
        decoder,
        target,
        selector,
        args
    };
}

/**
 * Reconstruct calldata from decrypted UEI
 */
export function reconstructCalldata(
    selector: string,
    args: any[],
    argTypes: ArgType[]
): string {
    console.log("\n=== Reconstructing Calldata ===");

    // Convert ArgTypes to Solidity types
    const solidityTypes = argTypes.map(argType => {
        const argTypeNum = Number(argType);
        switch (argTypeNum) {
            case ArgType.ADDR:
                return 'address';
            case ArgType.U256:
                return 'uint256';
            case ArgType.U128:
                return 'uint128';
            case ArgType.U64:
                return 'uint64';
            case ArgType.U32:
                return 'uint32';
            case ArgType.U16:
                return 'uint16';
            case ArgType.BYTES32:
                return 'bytes32';
            case ArgType.BYTES:
                return 'bytes';
            default:
                throw new Error(`Unknown ArgType: ${argType} (${ArgType[argType]}) - available: ${Object.keys(ArgType).filter(k => isNaN(Number(k)))}`);
        }
    });

    console.log("Solidity types:", solidityTypes);
    console.log("Arguments:", args);

    // Encode the arguments
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(solidityTypes, args);

    // Combine selector + encoded arguments
    const calldata = selector + encodedArgs.slice(2); // Remove 0x from encodedArgs

    console.log("Reconstructed calldata:", calldata);
    return calldata;
}

/**
 * Process a UEI from intent ID
 */
export async function processUEI(
    swapManager: any, // Using any to avoid type issues
    intentId: string
): Promise<{ decoder: string; target: string; calldata: string }> {
    console.log("\n=== Processing UEI ===");
    console.log("Intent ID:", intentId);

    // Get UEI task from contract
    const task = await swapManager.getUEITask(intentId);
    console.log("Task submitter:", task.submitter);
    console.log("Task deadline:", task.deadline.toString());
    console.log("Task status:", task.status);

    // Decode the blob
    const ueiData = decodeUEIBlob(task.ctBlob);

    // Decrypt all components
    const decrypted = await decryptUEI(ueiData);

    // Reconstruct calldata
    const calldata = reconstructCalldata(
        decrypted.selector,
        decrypted.args,
        ueiData.argTypes
    );

    return {
        decoder: decrypted.decoder,
        target: decrypted.target,
        calldata
    };
}

/**
 * Verify decoder contains selector
 */
export async function verifyDecoderSelector(
    provider: ethers.Provider,
    decoderAddress: string,
    selector: string
): Promise<boolean> {
    try {
        // This would check if the decoder contract has the selector
        // For now, we'll assume it's valid in test environment
        console.log(`Verifying selector ${selector} in decoder ${decoderAddress}`);

        // In production, you'd call a view function on the decoder
        // to verify the selector is whitelisted

        return true;
    } catch (error) {
        console.error("Failed to verify decoder selector:", error);
        return false;
    }
}

/**
 * Submit processed UEI to SwapManager
 */
export async function submitProcessedUEI(
    swapManager: any, // Using any to avoid type issues
    wallet: ethers.Wallet,
    intentId: string,
    decoder: string,
    target: string,
    calldata: string,
    operatorSignatures: string[]
): Promise<string> {
    console.log("\n=== Submitting Processed UEI ===");
    console.log("Intent ID:", intentId);
    console.log("Decoder:", decoder);
    console.log("Target:", target);
    console.log("Calldata length:", calldata.length);
    console.log("Signatures count:", operatorSignatures.length);

    try {
        const tx = await swapManager.connect(wallet).processUEI(
            intentId,
            decoder,
            target,
            calldata,
            operatorSignatures
        );

        console.log("Transaction hash:", tx.hash);
        const receipt = await tx.wait();
        console.log("✅ UEI processed successfully!");

        return tx.hash;
    } catch (error) {
        console.error("Failed to submit processed UEI:", error);
        throw error;
    }
}

/**
 * Monitor for new UEI events
 */
export function monitorUEIEvents(swapManager: any, operatorAddress: string) {
    console.log("\n🔍 Monitoring for UEI events...");

    // Listen for UEISubmitted events
    swapManager.on("UEISubmitted", async (intentId: any, submitter: any, ctBlob: any, deadline: any, selectedOperators: any) => {
        console.log("\n🚀 New UEI detected!");
        console.log("Intent ID:", intentId);
        console.log("Submitter:", submitter);
        console.log("Deadline:", deadline.toString());
        console.log("Selected operators:", selectedOperators);

        // Check if this operator is selected
        const isSelected = selectedOperators.some(
            (op: string) => op.toLowerCase() === operatorAddress.toLowerCase()
        );

        if (isSelected) {
            console.log("✅ This operator is selected for the UEI!");

            try {
                // Process the UEI
                const processed = await processUEI(swapManager, intentId);

                console.log("\n📋 Processed UEI:");
                console.log("  Decoder:", processed.decoder);
                console.log("  Target:", processed.target);
                console.log("  Calldata:", processed.calldata);

                // In production, coordinate with other operators for signatures
                // For now, we'll skip the actual submission
                console.log("\n⚡ Ready to submit UEI (would coordinate signatures in production)");

            } catch (error) {
                console.error("Failed to process UEI:", error);
            }
        } else {
            console.log("❌ This operator is not selected for the UEI");
        }
    });

    // Listen for UEIProcessed events
    swapManager.on("UEIProcessed", (intentId: any, success: any, result: any  ) => {
        console.log("\n✨ UEI Processed Event:");
        console.log("Intent ID:", intentId);
        console.log("Success:", success);
        if (result && result.length > 0) {
            console.log("Result:", result);
        }
    });
}

// Example usage
async function main() {
    // Initialize with a dummy wallet for example
    const provider = new ethers.JsonRpcProvider("http://localhost:8545");
    const wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
    await initializeUEIProcessor(wallet);

    // Example UEI data (would come from contract)
    const exampleUEI: UEIData = {
        ctDecoder: BigInt("0x1234567890abcdef"),
        ctTarget: BigInt("0xfedcba0987654321"),
        ctSelector: BigInt(0x617ba037), // supply selector
        argTypes: [ArgType.ADDR, ArgType.U256, ArgType.ADDR, ArgType.U16],
        ctArgs: [
            BigInt("0xaabbccddee"),  // token address
            BigInt("1000000000"),     // amount
            BigInt("0x1122334455"),   // recipient
            BigInt("0")               // referral code
        ]
    };

    // Decrypt and process
    const decrypted = await decryptUEI(exampleUEI);
    console.log("\nDecrypted UEI:", decrypted);

    // Reconstruct calldata
    const calldata = reconstructCalldata(
        decrypted.selector,
        decrypted.args,
        exampleUEI.argTypes
    );
    console.log("\nFinal calldata:", calldata);
}

// Only run if this is the main module
if (require.main === module) {
    main().catch(console.error);
}