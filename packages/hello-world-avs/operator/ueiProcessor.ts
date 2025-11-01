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
 *    - Call processUEI(intentIds[], decoders[], targets[], calldatas[], signatures[])
 * 5. Log execution results
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import {
    encodeProtocolCalldata,
    mapAddressForChain,
    prepareProtocolArguments,
    ProtocolCallLookupResult,
    resolveProtocolCall,
} from './utils';
import { registerConfiguredProtocolTargets } from './config/protocolTargets';
import { CHAIN_DEPLOYMENTS, ChainIdLiteral } from './config/chains';
import { getNexusSdk, initializeNexus } from './nexus';
import logger from './logger';

dotenv.config();

const PROVIDER_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_KEY';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

// Register protocol mappings for all known chains on startup
registerConfiguredProtocolTargets();

// Deployed contract addresses
const SWAP_MANAGER = '0x892c61920D2c8B8C94482b75e7044484dBFd75d4';
const BORING_VAULT = '0x1B7Bbc206Fc58413dCcDC9A4Ad1c5a95995a3926';

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
 * NEW FORMAT: abi.encode(bytes32 decoder, bytes32 target, bytes32 selector, bytes32 chainId, bytes32[] args)
 * NO argTypes array!
 */
function decodeCTBlob(ctBlob: string): {
    encDecoder: string;
    encTarget: string;
    encSelector: string;
    encChainId: string;
    encArgs: string[];
} {
    try {
        // Decode with NEW format (no argTypes!)
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32[]'],
            ctBlob
        );

        const [encDecoder, encTarget, encSelector, encChainId, encArgs] = decoded;

        console.log("📦 Decoded ctBlob:");
        console.log(`  Decoder handle: ${encDecoder}`);
        console.log(`  Target handle: ${encTarget}`);
        console.log(`  Selector handle: ${encSelector}`);
        console.log(`  ChainId handle: ${encChainId}`);
        console.log(`  Args count: ${encArgs.length}`);

        return {
            encDecoder,
            encTarget,
            encSelector,
            encChainId,
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
    encChainId: string,
    encArgs: string[],
    contractAddress: string,
    operatorWallet: ethers.Wallet
): Promise<{
    decoder: string;
    target: string;
    selector: string;
    chainId: number;
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
            { handle: encChainId, contractAddress },
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

        const maxHandlesPerCall = 2;
        const aggregatedResults: Array<string | number | bigint> = [];
        const totalChunks = Math.ceil(handleContractPairs.length / maxHandlesPerCall);

        for (let i = 0; i < handleContractPairs.length; i += maxHandlesPerCall) {
            const chunk = handleContractPairs.slice(i, i + maxHandlesPerCall);
            const chunkIndex = Math.floor(i / maxHandlesPerCall) + 1;

            logger.info(`UEI decrypt chunk ${chunkIndex}/${totalChunks}`, { handles: chunk.length });

            const chunkResults = await fhevm.userDecrypt(
                chunk,
                privateKey,
                publicKey,
                signature,
                contractAddresses,
                operatorWallet.address,
                startTimestamp,
                durationDays
            );

            const orderedChunk = Object.values(chunkResults).map(value => value as string | number | bigint);
            logger.info(`UEI decrypt chunk ${chunkIndex} results`, orderedChunk.map(value => value.toString()));
            aggregatedResults.push(...orderedChunk);
        }

        console.log(`✅ Successfully decrypted ${aggregatedResults.length} components across ${totalChunks} calls\n`);

        // Convert to appropriate types
        const decoder = ethers.getAddress(ethers.toBeHex(BigInt(aggregatedResults[0] as any), 20));
        const target = ethers.getAddress(ethers.toBeHex(BigInt(aggregatedResults[1] as any), 20));
        const selectorNum = Number(aggregatedResults[2]);
        const selector = `0x${selectorNum.toString(16).padStart(8, '0')}`;
        const chainId = Number(aggregatedResults[3]);
        const args = aggregatedResults.slice(4).map(val => BigInt(val as any));

        console.log("🔍 Decrypted UEI Details:");
        console.log(`  Decoder: ${decoder}`);
        console.log(`  Target: ${target}`);
        console.log(`  Selector: ${selector}`);
        console.log(`  ChainId: ${chainId}`);
        console.log(`  Args (${args.length}):`, args.map(a => a.toString()));

        return { decoder, target, selector, chainId, args };
    } catch (error) {
        console.error("❌ Decryption failed:", error);
        throw error;
    }
}

/**
 * Reconstruct calldata for simple transfer
 * For POC: assume transfer(address to, uint256 amount)
 */
function formatArgValue(value: string | bigint): string {
    return typeof value === 'bigint' ? value.toString() : value;
}

function reconstructCalldata(
    chainId: number,
    target: string,
    selector: string,
    args: bigint[]
): {
    definition: ProtocolCallLookupResult;
    calldata: string;
    preparedArgs: (string | bigint)[];
    mappedTarget: string;
    mappedArgs: bigint[];
} {
    console.log("\n🔧 Reconstructing calldata...");
    console.log(`  Target: ${target}`);
    console.log(`  Selector: ${selector}`);
    console.log(`  ChainId: ${chainId}`);

        try {
            const definition = resolveProtocolCall(chainId, target, selector);
            console.log(`  Protocol: ${definition.protocol}`);
            console.log(`  Function: ${definition.signature}`);

            const mappedTarget = mapAddressForChain(target, chainId);
            const mappedArgs = args.map((value, index) => {
                if (definition.argTypes[index] === "address") {
                    const canonicalAddress = ethers.getAddress(
                        ethers.toBeHex(value, 20)
                    );
                    const mapped = mapAddressForChain(canonicalAddress, chainId);
                    return ethers.toBigInt(mapped);
                }
                return value;
            });

            const preparedArgs = prepareProtocolArguments(definition, mappedArgs);
            definition.argNames.forEach((name, index) => {
                const value = preparedArgs[index];
                console.log(`    ${name}: ${formatArgValue(value)}`);
            });

            const calldata = encodeProtocolCalldata(definition, mappedArgs);
            console.log(`  Calldata: ${calldata}`);

            return {
                definition,
                calldata,
                preparedArgs,
                mappedTarget,
                mappedArgs,
            };
        } catch (error) {
            console.error("❌ Failed to reconstruct calldata:", error);
            throw error;
        }
}

async function createAggregatedSignature(
    operatorWallet: ethers.Wallet,
    batchId: string,
    intentIds: string[],
    decoders: string[],
    targets: string[],
    calldatas: string[]
): Promise<string> {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const dataHash = ethers.keccak256(
        abiCoder.encode(
            ['bytes32', 'bytes32[]', 'address[]', 'address[]', 'bytes[]'],
            [batchId, intentIds, decoders, targets, calldatas]
        )
    );

    const signature = await operatorWallet.signMessage(ethers.getBytes(dataHash));
    console.log(`\n✍️  Aggregated signature created: ${signature.slice(0, 20)}...`);
    return signature;
}

async function executeCrossChainProcessUEI(
    chainId: number,
    payload: ExecutionPayload,
    signature: string,
    swapManagerAbi: any,
    operatorWallet: ethers.Wallet
) {
    const deployment = CHAIN_DEPLOYMENTS[chainId as ChainIdLiteral];
    if (!deployment?.swapManager) {
        throw new Error(`SwapManager address not configured for chain ${chainId}`);
    }

    await ensureNexusInitialized(operatorWallet);
    const sdk = getNexusSdk();

    console.log(`\n🌐 Dispatching cross-chain processUEI to chain ${chainId}`);
    console.log(`  SwapManager: ${deployment.swapManager}`);

    await sdk.execute({
        toChainId: chainId as any,
        contractAddress: deployment.swapManager,
        contractAbi: swapManagerAbi,
        functionName: 'processUEI',
        buildFunctionParams: () => ({
            functionParams: [
                payload.intentIds,
                payload.decoders,
                payload.targets,
                payload.calldatas,
                [signature],
            ],
        }),
    });

    console.log("✅ Cross-chain processUEI dispatched via Nexus");
}

type PreparedIntent = {
    intentId: string;
    decoder: string;
    target: string;
    selector: string;
    chainId: number;
    calldata: string;
    args: bigint[];
    definition: ProtocolCallLookupResult;
    preparedArgs: (string | bigint)[];
};

type ExecutionPayload = {
    intentIds: string[];
    decoders: string[];
    targets: string[];
    calldatas: string[];
};

let nexusInitialized = false;

async function ensureNexusInitialized(operatorWallet: ethers.Wallet) {
    if (!nexusInitialized) {
        await initializeNexus(operatorWallet);
        nexusInitialized = true;
    }
}

function buildExecutionPayload(trades: PreparedIntent[]): ExecutionPayload {
    return {
        intentIds: trades.map((t) => t.intentId),
        decoders: trades.map((t) => t.decoder),
        targets: trades.map((t) => t.target),
        calldatas: trades.map((t) => t.calldata),
    };
}


async function processAggregatedUEIs(
    swapManager: ethers.Contract,
    swapManagerAbi: any,
    batchId: string,
    trades: PreparedIntent[],
    operatorWallet: ethers.Wallet,
    localChainId: number
) {
    if (!trades.length) {
        console.log("No trades to process for this batch.");
        return;
    }

    const tradesByChain = new Map<number, PreparedIntent[]>();
    for (const trade of trades) {
        const list = tradesByChain.get(trade.chainId) ?? [];
        list.push(trade);
        tradesByChain.set(trade.chainId, list);
    }

    for (const [chainId, chainTrades] of tradesByChain.entries()) {
        console.log(`\n📦 Preparing execution payload for chain ${chainId} (${chainTrades.length} intents)`);
        chainTrades.forEach((trade, index) => {
            console.log(`  Intent ${index + 1}: ${trade.intentId}`);
            console.log(`    Target: ${trade.target}`);
            console.log(`    Decoder: ${trade.decoder}`);
            console.log(`    Selector: ${trade.selector}`);
            console.log(`    Function: ${trade.definition.signature}`);
            trade.definition.argNames.forEach((name, idx) => {
                const value = trade.preparedArgs[idx];
                console.log(`      ${name}: ${formatArgValue(value)}`);
            });
            console.log(`    Calldata length: ${trade.calldata.length} chars`);
        });

        const payload = buildExecutionPayload(chainTrades);

        const signature = await createAggregatedSignature(
            operatorWallet,
            batchId,
            payload.intentIds,
            payload.decoders,
            payload.targets,
            payload.calldatas
        );

        if (chainId === localChainId) {
            console.log("\n📤 Submitting aggregated processUEI transaction on local chain...");
            const tx = await swapManager.processUEI(
                payload.intentIds,
                payload.decoders,
                payload.targets,
                payload.calldatas,
                [signature]
            );
            console.log(`  Transaction hash: ${tx.hash}`);
            console.log("  Waiting for confirmation...");

            const receipt = await tx.wait();
            console.log("✅ Aggregated UEIs processed successfully on local chain!");
            console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

            const abiCoder = ethers.AbiCoder.defaultAbiCoder();

            for (const trade of chainTrades) {
                const execution = await swapManager.getUEIExecution(trade.intentId);
                console.log("\n📊 Execution Result:");
                console.log(`  Intent ID: ${trade.intentId}`);
                console.log(`  Success: ${execution.success}`);
                console.log(`  Executor: ${execution.executor}`);
                console.log(`  Executed at: ${new Date(Number(execution.executedAt) * 1000).toLocaleString()}`);

                const needsDecode = chainTrades.length > 1 && execution.callData !== '0x';
                const needsResult = execution.result !== '0x';

                if (needsDecode || needsResult) {
                    let decodedCalldata: string[] = [];
                    if (needsDecode) {
                        const [callDatasPacked] = abiCoder.decode(['bytes[]'], execution.callData);
                        decodedCalldata = callDatasPacked as string[];
                    } else {
                        decodedCalldata = [execution.callData];
                    }

                    let operationResults: string[] = [];
                    if (needsResult) {
                        const [resultBytes] = abiCoder.decode(['bytes[]'], execution.result);
                        operationResults = resultBytes as string[];
                    }

                    decodedCalldata.forEach((calldata, index) => {
                        console.log(`  Step ${index + 1} calldata: ${calldata}`);
                        const result = operationResults[index] || '0x';
                        console.log(`  Step ${index + 1} result: ${result}`);
                    });
                }
            }
        } else {
            await executeCrossChainProcessUEI(
                chainId,
                payload,
                signature,
                swapManagerAbi,
                operatorWallet
            );
        }
    }
}

/**
 * Handle UEIBatchFinalized event
 */
async function handleBatchFinalized(
    provider: ethers.Provider,
    swapManager: ethers.Contract,
    swapManagerAbi: any,
    batchId: string,
    selectedOperators: string[],
    operatorWallet: ethers.Wallet,
    localChainId: number
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
        if (batch.executed) {
            console.log(`\n⚠️ Batch ${batchId} already executed on-chain. Skipping.`);
            console.log("=".repeat(80));
            return;
        }
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

        if (events.length === 0) {
            console.log("⚠️  No TradeSubmitted events found for this batch!");
            return;
        }

        const ctBlobMap = new Map<string, string>();
        for (const event of events) {
            if (!('args' in event) || !event.args) continue;
            const intentId = event.args[0] as string;
            const ctBlob = event.args[3] as string;
            ctBlobMap.set(intentId, ctBlob);
        }

        const preparedIntents: PreparedIntent[] = [];
        for (let i = 0; i < batch.intentIds.length; i++) {
            const intentId = batch.intentIds[i] as string;
            const ctBlob = ctBlobMap.get(intentId);
            if (!ctBlob) {
                console.warn(`⚠️  Missing ctBlob for intent ${intentId}, skipping`);
                continue;
            }

            console.log(`\n📥 Preparing intent ${i + 1}/${batch.intentIds.length} (${intentId})`);
            const decoded = decodeCTBlob(ctBlob);
            const decrypted = await batchDecryptUEI(
                decoded.encDecoder,
                decoded.encTarget,
                decoded.encSelector,
                decoded.encChainId,
                decoded.encArgs,
                SWAP_MANAGER,
                operatorWallet
            );
            const {
                definition,
                calldata,
                preparedArgs,
                mappedTarget,
                mappedArgs,
            } = reconstructCalldata(decrypted.chainId, decrypted.target, decrypted.selector, decrypted.args);

            preparedIntents.push({
                intentId,
                decoder: decrypted.decoder,
                target: mappedTarget,
                selector: decrypted.selector,
                chainId: decrypted.chainId,
                calldata,
                args: mappedArgs,
                definition,
                preparedArgs,
            });
        }

        await processAggregatedUEIs(
            swapManager,
            swapManagerAbi,
            batchId,
            preparedIntents,
            operatorWallet,
            localChainId
        );

        console.log("\n✅ Batch processed end-to-end!");
        console.log("=".repeat(80));

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
        const network = await provider.getNetwork();
        const localChainId = Number(network.chainId);

        console.log("👤 Operator wallet:", operatorWallet.address);
        console.log("🏦 SwapManager:", SWAP_MANAGER);
        console.log("💰 BoringVault:", BORING_VAULT);
        console.log("🌐 Local chainId:", localChainId);

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
            const fromBlock = Math.max(0, lastProcessedBlock - 100);
            const events = await swapManager.queryFilter(filter, fromBlock, lastProcessedBlock);

            if (events.length > 0) {
                console.log(`\n📜 Found ${events.length} past UEIBatchFinalized events`);
        for (const event of events) {
            if (!('args' in event) || !event.args) continue;

            const batchId = event.args[0];
            const selectedOperators = event.args[1];

            // TODO: Skip batches that are already executed once contract exposes execution status on-chain.
            if (!processedBatches.has(batchId)) {
                processedBatches.add(batchId);
                        await handleBatchFinalized(
                            provider,
                            swapManager,
                            swapManagerAbi,
                            batchId,
                            selectedOperators,
                            operatorWallet,
                            localChainId
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

                    // TODO: Skip batches that are already executed once contract exposes execution status on-chain.
                    if (!processedBatches.has(batchId)) {
                        processedBatches.add(batchId);
                        console.log(`\n🔔 New UEIBatchFinalized event detected at block ${event.blockNumber}`);

                            await handleBatchFinalized(
                                provider,
                                swapManager,
                                swapManagerAbi,
                                batchId,
                                selectedOperators,
                                operatorWallet,
                                localChainId
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

export { startUEIProcessor };
