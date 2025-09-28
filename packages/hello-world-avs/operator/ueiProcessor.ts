import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { initializeFhevm } from './fhevmUtils';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

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

// UEI structure (updated for new blob format)
interface UEIData {
    encDecoder: string;     // Encrypted decoder address handle (bytes32)
    encTarget: string;      // Encrypted target address handle (bytes32)
    encSelector: string;    // Encrypted function selector handle (bytes32)
    argTypes: ArgType[];    // Argument types (unencrypted)
    encArgs: string[];      // Encrypted arguments handles (bytes32[])
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
 * Decode UEI blob from contract (updated for new batched encryption format)
 */
export function decodeUEIBlob(ctBlob: string): UEIData {
    try {
        console.log("Decoding UEI blob:", ctBlob.length, "bytes");

        // Decode the blob using new format
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['bytes32', 'bytes32', 'bytes32', 'uint8[]', 'bytes32[]'],
            ctBlob
        );

        const [encDecoder, encTarget, encSelector, argTypes, encArgs] = decoded;

        console.log("Decoded UEI components:");
        console.log("  Decoder handle:", encDecoder);
        console.log("  Target handle:", encTarget);
        console.log("  Selector handle:", encSelector);
        console.log("  Arg types:", argTypes);
        console.log("  Arg handles:", encArgs.length);

        return {
            encDecoder,
            encTarget,
            encSelector,
            argTypes: argTypes.map((t: number) => t as ArgType),
            encArgs
        };
    } catch (error) {
        console.error("Failed to decode UEI blob:", error);
        throw error;
    }
}

// Initialize FHEVM instance globally for UEI decryption
let fhevmInstance: any = null;

async function initializeFhevmInstance() {
    if (!fhevmInstance) {
        // Create FHEVM instance for the current network
        const networkUrl = process.env.RPC_URL || "http://localhost:8545";
        console.log("Creating FHEVM instance with network:", networkUrl);

        fhevmInstance = await createInstance({
            ...SepoliaConfig,
            network: networkUrl
        });

        console.log("FHEVM instance created successfully");
    }
    return fhevmInstance;
}

/**
 * Batch decrypt all UEI components using ZAMA FHEVM
 */
async function batchDecryptUEIComponents(
    ueiData: UEIData,
    contractAddress: string,
    operatorWallet: ethers.Wallet
): Promise<{
    decoder: string;
    target: string;
    selector: string;
    args: any[];
}> {
    try {
        console.log("Batch decrypting UEI components using ZAMA FHEVM...");

        const fhevm = await initializeFhevmInstance();

        // Prepare all handles for batch decryption
        const handleContractPairs = [
            { handle: ueiData.encDecoder, contractAddress },
            { handle: ueiData.encTarget, contractAddress },
            { handle: ueiData.encSelector, contractAddress },
            ...ueiData.encArgs.map(handle => ({ handle, contractAddress }))
        ];

        console.log(`Prepared ${handleContractPairs.length} handles for batch decryption`);

        // Generate keypair for decryption
        const { publicKey, privateKey } = fhevm.generateKeypair();

        // Create EIP712 signature
        const contractAddresses = [contractAddress];
        const startTimestamp = Math.floor(Date.now() / 1000);
        const durationDays = 7;

        const eip712 = fhevm.createEIP712(
            publicKey,
            contractAddresses,
            startTimestamp,
            durationDays
        );

        const typesWithoutDomain = { ...eip712.types };
        delete typesWithoutDomain.EIP712Domain;

        // Sign with operator wallet
        const signature = await operatorWallet.signTypedData(
            eip712.domain,
            typesWithoutDomain,
            eip712.message
        );

        // Batch decrypt all components
        const decryptedResults = await fhevm.userDecrypt(
            handleContractPairs,
            privateKey,
            publicKey,
            signature,
            contractAddresses,
            operatorWallet.address,
            startTimestamp,
            durationDays
        );

        const results = Object.values(decryptedResults);
        console.log(`Successfully batch decrypted ${results.length} components`);

        // Convert results back to appropriate types
        const decoder = ethers.getAddress(ethers.toBeHex(BigInt(results[0] as any), 20));
        const target = ethers.getAddress(ethers.toBeHex(BigInt(results[1] as any), 20));
        const selectorNum = Number(results[2]); // euint32 -> number
        const selector = `0x${selectorNum.toString(16).padStart(8, '0')}`;

        // Process arguments based on their types
        const args: any[] = [];
        for (let i = 0; i < ueiData.argTypes.length; i++) {
            const rawValue = BigInt(results[3 + i] as any);
            const argType = ueiData.argTypes[i];
            
            const processedArg = convertDecryptedArgument(rawValue, argType);
            args.push(processedArg);
            
            console.log(`  Arg[${i}] (${ArgType[argType]}): ${processedArg}`);
        }

        console.log("✅ Batch decrypted UEI components:");
        console.log("  Decoder:", decoder);
        console.log("  Target:", target);
        console.log("  Selector:", selector);

        return { decoder, target, selector, args };

    } catch (error) {
        console.error("Error in batch UEI decryption:", error);
        throw error;
    }
}

/**
 * Convert decrypted raw value to appropriate type based on ArgType
 */
function convertDecryptedArgument(rawValue: bigint, argType: ArgType): any {
    const argTypeNum = Number(argType);

    switch (argTypeNum) {
        case ArgType.ADDR:
            return ethers.getAddress(ethers.toBeHex(rawValue, 20));

        case ArgType.U256:
        case ArgType.U128:
        case ArgType.U64:
        case ArgType.U32:
        case ArgType.U16:
            return rawValue;

        case ArgType.BYTES32:
            return ethers.toBeHex(rawValue, 32);

        case ArgType.BYTES:
            return ethers.toBeHex(rawValue);

        default:
            throw new Error(`Unsupported argument type: ${argType} (${ArgType[argType]})`);
    }
}

// Legacy functions removed - now using batch decryption approach

/**
 * Decrypt entire UEI using batch decryption
 */
export async function decryptUEI(
    ueiData: UEIData, 
    contractAddress: string,
    operatorWallet: ethers.Wallet
): Promise<DecryptedUEI> {
    console.log("\n=== Batch Decrypting UEI ===");

    // Initialize FHEVM instance
    await initializeFhevmInstance();

    // Batch decrypt all components
    const decrypted = await batchDecryptUEIComponents(ueiData, contractAddress, operatorWallet);

    return {
        decoder: decrypted.decoder,
        target: decrypted.target,
        selector: decrypted.selector,
        args: decrypted.args
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
 * Process a UEI from intent ID using batch decryption
 */
export async function processUEI(
    swapManager: any, // Using any to avoid type issues
    intentId: string,
    operatorWallet: ethers.Wallet,
    contractAddress: string
): Promise<{ decoder: string; target: string; calldata: string }> {
    console.log("\n=== Processing UEI with Batch Decryption ===");
    console.log("Intent ID:", intentId);

    // Get UEI task from contract
    const task = await swapManager.getUEITask(intentId);
    console.log("Task submitter:", task.submitter);
    console.log("Task deadline:", task.deadline.toString());
    console.log("Task status:", task.status);

    // Decode the blob
    const ueiData = decodeUEIBlob(task.ctBlob);

    // Batch decrypt all components
    const decrypted = await decryptUEI(ueiData, contractAddress, operatorWallet);

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
 * Monitor for new UEI events (updated for new batch decryption)
 */
export function monitorUEIEvents(
    swapManager: any, 
    operatorWallet: ethers.Wallet,
    contractAddress: string
) {
    console.log("\n🔍 Monitoring for UEI events...");
    console.log("Operator address:", operatorWallet.address);
    console.log("Contract address:", contractAddress);

    // Listen for UEISubmitted events (legacy)
    swapManager.on("UEISubmitted", async (intentId: any, submitter: any, ctBlob: any, deadline: any, selectedOperators: any) => {
        console.log("\n🚀 New UEI detected (legacy)!");
        console.log("Intent ID:", intentId);
        console.log("Submitter:", submitter);
        console.log("Deadline:", deadline.toString());
        console.log("Selected operators:", selectedOperators);

        await handleUEIEvent(swapManager, intentId, selectedOperators, operatorWallet, contractAddress, false);
    });

    // Listen for UEISubmittedWithProof events (new batched)
    swapManager.on("UEISubmittedWithProof", async (intentId: any, submitter: any, ctBlob: any, inputProof: any, deadline: any, selectedOperators: any) => {
        console.log("\n🚀 New UEI detected (with proof)!");
        console.log("Intent ID:", intentId);
        console.log("Submitter:", submitter);
        console.log("Input proof length:", inputProof.length);
        console.log("Deadline:", deadline.toString());
        console.log("Selected operators:", selectedOperators);

        await handleUEIEvent(swapManager, intentId, selectedOperators, operatorWallet, contractAddress, true);
    });

    // Listen for UEIProcessed events
    swapManager.on("UEIProcessed", (intentId: any, success: any, result: any) => {
        console.log("\n✨ UEI Processed Event:");
        console.log("Intent ID:", intentId);
        console.log("Success:", success);
        if (result && result.length > 0) {
            console.log("Result:", result);
        }
    });
}

/**
 * Handle UEI event processing
 */
async function handleUEIEvent(
    swapManager: any,
    intentId: string,
    selectedOperators: string[],
    operatorWallet: ethers.Wallet,
    contractAddress: string,
    hasProof: boolean
) {
    // Check if this operator is selected
    const isSelected = selectedOperators.some(
        (op: string) => op.toLowerCase() === operatorWallet.address.toLowerCase()
    );

    if (isSelected) {
        console.log("✅ This operator is selected for the UEI!");
        console.log(`📋 Processing with ${hasProof ? 'batch decryption (with proof)' : 'legacy decryption'}`);

        try {
            // Process the UEI using batch decryption
            const processed = await processUEI(swapManager, intentId, operatorWallet, contractAddress);

            console.log("\n📋 Processed UEI:");
            console.log("  Decoder:", processed.decoder);
            console.log("  Target:", processed.target);
            console.log("  Calldata:", processed.calldata);

            // In production, coordinate with other operators for signatures
            // For now, we'll skip the actual submission
            console.log("\n⚡ Ready to submit UEI (would coordinate signatures in production)");

        } catch (error) {
            console.error("Failed to process UEI:", error);
            console.error("Error details:", (error as any).message);
        }
    } else {
        console.log("❌ This operator is not selected for the UEI");
    }
}

// Example usage
async function main() {
    // Initialize with a dummy wallet for example
    const provider = new ethers.JsonRpcProvider("http://localhost:8545");
    const wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
    await initializeUEIProcessor(wallet);

    // Example UEI data (updated for new format)
    const exampleUEI: UEIData = {
        encDecoder: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        encTarget: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
        encSelector: "0x617ba037617ba037617ba037617ba037617ba037617ba037617ba037617ba037",
        argTypes: [ArgType.ADDR, ArgType.U256, ArgType.ADDR, ArgType.U16],
        encArgs: [
            "0xaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbcc",  // token address
            "0x1000000000100000000010000000001000000000100000000010000000001000",     // amount
            "0x1122334455112233445511223344551122334455112233445511223344551122",   // recipient
            "0x0000000000000000000000000000000000000000000000000000000000000000"    // referral code
        ]
    };

    const contractAddress = "0x1234567890123456789012345678901234567890";

    // Decrypt and process using batch decryption
    const decrypted = await decryptUEI(exampleUEI, contractAddress, wallet);
    console.log("\nBatch Decrypted UEI:", decrypted);

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