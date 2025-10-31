/**
 * UEI Processor - Listens for batch finalization and processes encrypted UEI trades
 *
 * Complete Flow:
 * 1. Listen for UEIBatchFinalized event → get batchId & selectedOperators
 * 2. Check if this operator is selected
 * 3. Query past TradeSubmitted events filtered by batchId
 * 4. For each trade in batch:
 *    - Extract ctBlob from TradeSubmitted event (NOT from contract storage!)
 *    - Decode ctBlob to get encrypted handles
 *    - Batch decrypt all components using FHEVM
 *    - Reconstruct calldata (for POC: simple transfer)
 *    - Get consensus signatures from other operators
 *    - Call processUEI(intentId, decoder, target, calldata, signatures)
 * 5. Log execution results
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

dotenv.config();

const PROVIDER_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_KEY';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

// Deployed contract addresses
const SWAP_MANAGER = '0xE1e00b5d08a08Cb141a11a922e48D4c06d66D3bf';
const BORING_VAULT = '0x4D2a5229C238EEaF5DB0912eb4BE7c39575369f0';

// FHEVM instance for decryption
let fhevmInstance: any = null;

async function initializeFhevmInstance() {
    if (!fhevmInstance) {
        console.log("🔐 Initializing FHEVM for decryption...");
        fhevmInstance = await createInstance({
            ...SepoliaConfig,
            network: PROVIDER_URL
        });
        console.log("✅ FHEVM initialized\n");
    }
    return fhevmInstance;
}

/**
 * Decode ctBlob to extract encrypted handles
 * NEW FORMAT: abi.encode(bytes32 decoder, bytes32 target, bytes32 selector, bytes32[] args)
 * NO argTypes array!
 */
function decodeCTBlob(ctBlob: string): {
    encDecoder: string;
    encTarget: string;
    encSelector: string;
    encArgs: string[];
} {
    try {
        // Decode with NEW format (no argTypes!)
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['bytes32', 'bytes32', 'bytes32', 'bytes32[]'],
            ctBlob
        );

        const [encDecoder, encTarget, encSelector, encArgs] = decoded;

        console.log("📦 Decoded ctBlob:");
        console.log(`  Decoder handle: ${encDecoder}`);
        console.log(`  Target handle: ${encTarget}`);
        console.log(`  Selector handle: ${encSelector}`);
        console.log(`  Args count: ${encArgs.length}`);

        return {
            encDecoder,
            encTarget,
            encSelector,
            encArgs
        };
    } catch (error) {
        console.error("❌ Failed to decode ctBlob:", error);
        throw error;
    }
}

/**
 * Batch decrypt all UEI components using FHEVM
 */
async function batchDecryptUEI(
    encDecoder: string,
    encTarget: string,
    encSelector: string,
    encArgs: string[],
    contractAddress: string,
    operatorWallet: ethers.Wallet
): Promise<{
    decoder: string;
    target: string;
    selector: string;
    args: bigint[];
}> {
    try {
        console.log("\n🔓 Batch decrypting UEI components...");

        const fhevm = await initializeFhevmInstance();

        // Prepare all handles for batch decryption
        const handleContractPairs = [
            { handle: encDecoder, contractAddress },
            { handle: encTarget, contractAddress },
            { handle: encSelector, contractAddress },
            ...encArgs.map(handle => ({ handle, contractAddress }))
        ];

        console.log(`  Prepared ${handleContractPairs.length} handles for decryption`);

        // Generate keypair
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
        console.log(`✅ Successfully decrypted ${results.length} components\n`);

        // Convert to appropriate types
        const decoder = ethers.getAddress(ethers.toBeHex(BigInt(results[0] as any), 20));
        const target = ethers.getAddress(ethers.toBeHex(BigInt(results[1] as any), 20));
        const selectorNum = Number(results[2]);
        const selector = `0x${selectorNum.toString(16).padStart(8, '0')}`;
        const args = results.slice(3).map(val => BigInt(val as any));

        console.log("🔍 Decrypted UEI Details:");
        console.log(`  Decoder: ${decoder}`);
        console.log(`  Target: ${target}`);
        console.log(`  Selector: ${selector}`);
        console.log(`  Args (${args.length}):`, args.map(a => a.toString()));

        return { decoder, target, selector, args };
    } catch (error) {
        console.error("❌ Decryption failed:", error);
        throw error;
    }
}

/**
 * Reconstruct calldata for simple transfer
 * For POC: assume transfer(address to, uint256 amount)
 */
function reconstructTransferCalldata(
    selector: string,
    args: bigint[]
): string {
    console.log("\n🔧 Reconstructing calldata...");

    // For transfer: args[0] = recipient (address), args[1] = amount (uint256)
    if (args.length !== 2) {
        throw new Error(`Expected 2 args for transfer, got ${args.length}`);
    }

    const recipient = ethers.getAddress(ethers.toBeHex(args[0], 20));
    const amount = args[1];

    console.log(`  Function: transfer(address,uint256)`);
    console.log(`  Recipient: ${recipient}`);
    console.log(`  Amount: ${amount.toString()}`);

    // Encode arguments
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256'],
        [recipient, amount]
    );

    // Combine selector + encoded args
    const calldata = selector + encodedArgs.slice(2);

    console.log(`  Calldata: ${calldata}`);
    return calldata;
}

/**
 * Create operator signature for consensus
 */
async function createOperatorSignature(
    operatorWallet: ethers.Wallet,
    intentId: string,
    decoder: string,
    target: string,
    reconstructedData: string
): Promise<string> {
    // Create hash of the data
    const dataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'address', 'address', 'bytes'],
            [intentId, decoder, target, reconstructedData]
        )
    );

    // Sign with EIP-191 prefix (eth_sign format)
    const signature = await operatorWallet.signMessage(ethers.getBytes(dataHash));

    console.log(`  Signature created: ${signature.slice(0, 20)}...`);
    return signature;
}

/**
 * Process a single UEI trade
 */
async function processUEITrade(
    swapManager: ethers.Contract,
    intentId: string,
    ctBlob: string,
    operatorWallet: ethers.Wallet
): Promise<void> {
    try {
        console.log("\n" + "=".repeat(80));
        console.log(`🎯 Processing UEI: ${intentId}`);
        console.log("=".repeat(80));

        // Step 1: Decode ctBlob
        const decoded = decodeCTBlob(ctBlob);

        // Step 2: Batch decrypt
        const decrypted = await batchDecryptUEI(
            decoded.encDecoder,
            decoded.encTarget,
            decoded.encSelector,
            decoded.encArgs,
            SWAP_MANAGER,
            operatorWallet
        );

        // Step 3: Reconstruct calldata
        const calldata = reconstructTransferCalldata(decrypted.selector, decrypted.args);

        // Step 4: Create operator signature
        console.log("\n✍️  Creating operator signature...");
        const signature = await createOperatorSignature(
            operatorWallet,
            intentId,
            decrypted.decoder,
            decrypted.target,
            calldata
        );

        // Step 5: Submit to processUEI
        console.log("\n📤 Submitting processUEI transaction...");
        console.log(`  Intent ID: ${intentId}`);
        console.log(`  Decoder: ${decrypted.decoder}`);
        console.log(`  Target: ${decrypted.target}`);
        console.log(`  Calldata length: ${calldata.length} chars`);

        const tx = await swapManager.processUEI(
            intentId,
            decrypted.decoder,
            decrypted.target,
            calldata,
            [signature] // Array of signatures (single operator for POC)
        );

        console.log(`  Transaction hash: ${tx.hash}`);
        console.log("  Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log("✅ UEI processed successfully!");
        console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

        // Check execution result
        const execution = await swapManager.getUEIExecution(intentId);
        console.log("\n📊 Execution Result:");
        console.log(`  Success: ${execution.success}`);
        console.log(`  Executor: ${execution.executor}`);
        console.log(`  Executed at: ${new Date(Number(execution.executedAt) * 1000).toLocaleString()}`);

        if (execution.result && execution.result !== '0x') {
            console.log(`  Result: ${execution.result}`);
        }

        console.log("\n" + "=".repeat(80));

    } catch (error: any) {
        console.error(`\n❌ Failed to process UEI ${intentId}:`, error.message);
        throw error;
    }
}

/**
 * Handle UEIBatchFinalized event
 */
async function handleBatchFinalized(
    provider: ethers.Provider,
    swapManager: ethers.Contract,
    batchId: string,
    selectedOperators: string[],
    operatorWallet: ethers.Wallet
): Promise<void> {
    try {
        console.log("\n🚀 UEI Batch Finalized!");
        console.log("=" .repeat(80));
        console.log(`  Batch ID: ${batchId}`);
        console.log(`  Selected Operators (${selectedOperators.length}):`);
        selectedOperators.forEach((op, i) => console.log(`    ${i + 1}. ${op}`));

        // Check if this operator is selected
        const isSelected = selectedOperators.some(
            op => op.toLowerCase() === operatorWallet.address.toLowerCase()
        );

        if (!isSelected) {
            console.log(`\n❌ This operator (${operatorWallet.address}) is NOT selected`);
            console.log("=" .repeat(80));
            return;
        }

        console.log(`\n✅ This operator IS selected for this batch!`);

        // Get batch details
        const batch = await swapManager.getTradeBatch(batchId);
        console.log(`\n📋 Batch contains ${batch.intentIds.length} trades:`);
        batch.intentIds.forEach((id: string, i: number) => {
            console.log(`  ${i + 1}. ${id}`);
        });

        // Query past TradeSubmitted events for this batchId
        // CRITICAL: ctBlob is in events, NOT contract storage!
        console.log(`\n🔍 Fetching TradeSubmitted events for batch ${batchId}...`);

        const filter = swapManager.filters.TradeSubmitted(null, null, batchId);
        const currentBlock = await provider.getBlockNumber();
        const events = await swapManager.queryFilter(filter, currentBlock - 10000, currentBlock);

        console.log(`  Found ${events.length} TradeSubmitted events`);

        if (events.length === 0) {
            console.log("⚠️  No TradeSubmitted events found for this batch!");
            return;
        }

        // Process each trade
        for (let i = 0; i < events.length; i++) {
            const event = events[i];

            // Extract args from EventLog
            if (!('args' in event) || !event.args) continue;

            const intentId = event.args[0];
            const ctBlob = event.args[3]; // ctBlob is 4th parameter in TradeSubmitted

            console.log(`\n📥 Processing trade ${i + 1}/${events.length}...`);

            await processUEITrade(swapManager, intentId, ctBlob, operatorWallet);

            // Small delay between processing trades
            if (i < events.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log("\n✅ All trades in batch processed!");
        console.log("=" .repeat(80));

    } catch (error: any) {
        console.error("\n❌ Error handling batch finalization:", error.message);
        throw error;
    }
}

/**
 * Main UEI Processor - Monitors and processes batches
 */
async function startUEIProcessor() {
    try {
        console.log("\n🤖 Starting UEI Processor...\n");
        console.log("=" .repeat(80));

        // Setup
        const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
        const operatorWallet = new ethers.Wallet(PRIVATE_KEY, provider);

        console.log("👤 Operator wallet:", operatorWallet.address);
        console.log("🏦 SwapManager:", SWAP_MANAGER);
        console.log("💰 BoringVault:", BORING_VAULT);

        // Load SwapManager ABI
        const swapManagerAbi = JSON.parse(
            fs.readFileSync('./abis/SwapManager.json', 'utf8')
        );
        const swapManager = new ethers.Contract(SWAP_MANAGER, swapManagerAbi, operatorWallet);

        // Initialize FHEVM
        await initializeFhevmInstance();

        console.log("\n👂 Starting event polling for UEIBatchFinalized...");
        console.log("(Ankr RPC doesn't support eth_newFilter)");
        console.log("=" .repeat(80));

        // Track processed batches and blocks
        let lastProcessedBlock = await provider.getBlockNumber();
        const processedBatches = new Set<string>();

        // Query past UEIBatchFinalized events first (last 1000 blocks)
        try {
            const filter = swapManager.filters.UEIBatchFinalized();
            const fromBlock = Math.max(0, lastProcessedBlock - 1000);
            const events = await swapManager.queryFilter(filter, fromBlock, lastProcessedBlock);

            if (events.length > 0) {
                console.log(`\n📜 Found ${events.length} past UEIBatchFinalized events`);
                for (const event of events) {
                    if (!('args' in event) || !event.args) continue;

                    const batchId = event.args[0];
                    const selectedOperators = event.args[1];

                    if (!processedBatches.has(batchId)) {
                        processedBatches.add(batchId);
                        await handleBatchFinalized(
                            provider,
                            swapManager,
                            batchId,
                            selectedOperators,
                            operatorWallet
                        ).catch(error => {
                            console.error("Error processing past batch:", error);
                        });
                    }
                }
            } else {
                console.log("\n📜 No past UEIBatchFinalized events found");
            }
        } catch (error) {
            console.error("Error querying past events:", error);
        }

        console.log("\n✅ UEI Processor is running...");
        console.log("Polling every 5 seconds for new batches...");
        console.log("Press Ctrl+C to stop\n");

        // Poll for new events every 5 seconds
        setInterval(async () => {
            try {
                const currentBlock = await provider.getBlockNumber();

                if (currentBlock > lastProcessedBlock) {
                    const filter = swapManager.filters.UEIBatchFinalized();
                    const events = await swapManager.queryFilter(
                        filter,
                        lastProcessedBlock + 1,
                        currentBlock
                    );

                    for (const event of events) {
                        if (!('args' in event) || !event.args) continue;

                        const batchId = event.args[0];
                        const selectedOperators = event.args[1];

                        if (!processedBatches.has(batchId)) {
                            processedBatches.add(batchId);
                            console.log(`\n🔔 New UEIBatchFinalized event detected at block ${event.blockNumber}`);

                            await handleBatchFinalized(
                                provider,
                                swapManager,
                                batchId,
                                selectedOperators,
                                operatorWallet
                            ).catch(error => {
                                console.error("Error processing batch:", error);
                            });
                        }
                    }

                    lastProcessedBlock = currentBlock;
                }
            } catch (error: any) {
                console.error("Error in polling:", error.message);
            }
        }, 5000); // Poll every 5 seconds

        // Keep process alive
        await new Promise(() => {});

    } catch (error: any) {
        console.error("\n❌ UEI Processor failed to start:", error.message);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    startUEIProcessor().catch(console.error);
}

export { startUEIProcessor, processUEITrade };
