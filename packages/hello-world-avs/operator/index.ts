import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { initializeFhevm, decryptAmount, batchDecryptAmounts, encryptAmount, batchEncryptAmounts } from "./fhevmUtils";
import { initializeUEIProcessor, processUEI, monitorUEIEvents, decodeUEIBlob, reconstructCalldata } from './ueiProcessor';
const fs = require('fs');
const path = require('path');
dotenv.config();

// Check if the process.env object is empty
if (!Object.keys(process.env).length) {
    throw new Error("process.env object is empty");
}

// Setup env variables
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
/// TODO: Hack
let chainId = 31337;

const avsDeploymentData = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../contracts/deployments/swap-manager/${chainId}.json`), 'utf8'));
// Load core deployment data
const coreDeploymentData = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../contracts/deployments/core/${chainId}.json`), 'utf8'));


const delegationManagerAddress = coreDeploymentData.addresses.delegationManager; // todo: reminder to fix the naming of this contract in the deployment file, change to delegationManager
const avsDirectoryAddress = coreDeploymentData.addresses.avsDirectory;
const SwapManagerAddress = avsDeploymentData.addresses.SwapManager;
const ecdsaStakeRegistryAddress = avsDeploymentData.addresses.stakeRegistry;



// Load ABIs
const delegationManagerABI = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../abis/IDelegationManager.json'), 'utf8'));
const ecdsaRegistryABI = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../abis/ECDSAStakeRegistry.json'), 'utf8'));
const SwapManagerABI = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../abis/SwapManager.json'), 'utf8'));
const avsDirectoryABI = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../abis/IAVSDirectory.json'), 'utf8'));

// Initialize contract objects from ABIs
const delegationManager = new ethers.Contract(delegationManagerAddress, delegationManagerABI, wallet);
const SwapManager = new ethers.Contract(SwapManagerAddress, SwapManagerABI, wallet);
const ecdsaRegistryContract = new ethers.Contract(ecdsaStakeRegistryAddress, ecdsaRegistryABI, wallet);
const avsDirectory = new ethers.Contract(avsDirectoryAddress, avsDirectoryABI, wallet);



const registerOperator = async () => {

    // Registers as an Operator in EigenLayer.
    try {
        const nonce = await wallet.getNonce();
        const tx1 = await delegationManager.registerAsOperator(
            "0x0000000000000000000000000000000000000000", // initDelegationApprover
            0, // allocationDelay
            "", // metadataURI
            { nonce }
        );
        await tx1.wait();
        console.log("Operator registered to Core EigenLayer contracts");
    } catch (error: any) {
        if (error.data === "0x77e56a06") {
            console.log("Operator already registered to Core EigenLayer contracts");
        } else {
            console.error("Error in registering as operator:", error);
        }
    }

    try {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const expiry = Math.floor(Date.now() / 1000) + 3600; // Example expiry, 1 hour from now

        // Define the output structure
        let operatorSignatureWithSaltAndExpiry = {
            signature: "",
            salt: salt,
            expiry: expiry
        };

        // Calculate the digest hash, which is a unique value representing the operator, avs, unique value (salt) and expiration date.
        const operatorDigestHash = await avsDirectory.calculateOperatorAVSRegistrationDigestHash(
            wallet.address,
            await SwapManager.getAddress(),
            salt,
            expiry
        );
        console.log(operatorDigestHash);

        // Sign the digest hash with the operator's private key
        console.log("Signing digest hash with operator's private key");
        const operatorSigningKey = new ethers.SigningKey(process.env.PRIVATE_KEY!);
        const operatorSignedDigestHash = operatorSigningKey.sign(operatorDigestHash);

        // Encode the signature in the required format
        operatorSignatureWithSaltAndExpiry.signature = ethers.Signature.from(operatorSignedDigestHash).serialized;

        console.log("Registering Operator to AVS Registry contract");

        // Register Operator to AVS
        // Per release here: https://github.com/Layr-Labs/eigenlayer-middleware/blob/v0.2.1-mainnet-rewards/src/unaudited/ECDSAStakeRegistry.sol#L49
        const nonce2 = await wallet.getNonce();
        const tx2 = await ecdsaRegistryContract.registerOperatorWithSignature(
            operatorSignatureWithSaltAndExpiry,
            wallet.address,
            { nonce: nonce2 }
        );
        await tx2.wait();
        console.log("Operator registered on AVS successfully");
    } catch (error: any) {
        if (error.data === "0x42ee68b5" || error.code === "BAD_DATA") {
            console.log("Operator may already be registered on AVS or AVS not properly initialized");
        } else {
            console.error("Error registering operator on AVS:", error);
        }
    }
    
    // Register with SwapManager for batch processing
    try {
        // Check if already registered first
        const isAlreadyRegistered = await SwapManager.isOperatorRegistered(wallet.address);
        if (isAlreadyRegistered) {
            console.log("Operator already registered for batch processing");
        } else {
            console.log("Registering operator for batch processing...");
            const nonce3 = await wallet.getNonce();
            const tx3 = await SwapManager.registerOperatorForBatches({ nonce: nonce3 });
            await tx3.wait();
            console.log("Operator successfully registered for batch processing");
        }
        
        // Verify registration
        const isRegistered = await SwapManager.isOperatorRegistered(wallet.address);
        console.log(`Operator registration verified: ${isRegistered}`);
    } catch (error: any) {
        console.error("Error registering for batches:");
        console.error("Message:", error.message);
        if (error.reason) console.error("Reason:", error.reason);
        if (error.data) console.error("Data:", error.data);
        
        // Check if it's because not registered with stake registry
        try {
            const isRegisteredWithStake = await ecdsaRegistryContract.operatorRegistered(wallet.address);
            console.error(`Registered with ECDSAStakeRegistry: ${isRegisteredWithStake}`);
        } catch (e) {
            console.error("Could not check stake registry status");
        }
    }
};

// Structure to hold intent details
interface Intent {
    intentId: string;
    user: string;
    tokenIn: string;
    tokenOut: string;
    encryptedAmount: string;
    deadline?: bigint;
    decryptedAmount?: bigint;
}

// Structure for internal transfers matching the hook's interface
interface InternalTransfer {
    from: string;
    to: string;
    encToken: string;  // The encrypted token contract address
    encAmount: bigint;  // The encrypted amount (euint128 as bigint/ctHash)
}

// Structure for user shares in AMM output
interface UserShare {
    user: string;
    shareNumerator: bigint;
    shareDenominator: bigint;
}

// Structure for the complete settlement
interface SettlementData {
    internalTransfers: InternalTransfer[];
    netAmountIn: bigint;
    tokenIn: string;
    tokenOut: string;
    outputToken: string;
    userShares: UserShare[];
}

// FIFO matching algorithm - keep the original working logic
const matchIntents = async (intents: Intent[]): Promise<SettlementData> => {
    console.log(`\n=== Starting FIFO Order Matching ===`);
    console.log(`Processing ${intents.length} intents`);

    const internalTransfers: InternalTransfer[] = [];
    const unmatchedByPair = new Map<string, Intent[]>();

    // Track matches for creating proper internal transfers
    interface MatchedPair {
        userA: string;
        userB: string;
        tokenA: string;
        tokenB: string;
        amount: bigint;
    }
    const matchedPairs: MatchedPair[] = [];

    // Group intents by trading pair - KEEP ORIGINAL LOGIC
    for (const intent of intents) {
        const pair = `${intent.tokenIn}->${intent.tokenOut}`;
        const reversePair = `${intent.tokenOut}->${intent.tokenIn}`;

        // Check if there's a matching intent in the opposite direction
        const reverseQueue = unmatchedByPair.get(reversePair) || [];

        if (reverseQueue.length > 0) {
            // Match with first intent in reverse queue (FIFO)
            const matchedIntent = reverseQueue[0];
            const matchAmount = intent.decryptedAmount! < matchedIntent.decryptedAmount!
                ? intent.decryptedAmount!
                : matchedIntent.decryptedAmount!;

            // Store the matched pair for internal transfers
            matchedPairs.push({
                userA: matchedIntent.user,
                userB: intent.user,
                tokenA: matchedIntent.tokenIn,
                tokenB: intent.tokenIn, // intent.tokenIn = matchedIntent.tokenOut
                amount: matchAmount
            });

            console.log(`Matched: ${matchedIntent.user} <-> ${intent.user} for ${matchAmount}`);

            // Update or remove matched intent
            matchedIntent.decryptedAmount! -= matchAmount;
            if (matchedIntent.decryptedAmount! === 0n) {
                reverseQueue.shift();
            }

            // Update current intent
            intent.decryptedAmount! -= matchAmount;

            // If intent still has remaining amount, add to unmatched
            if (intent.decryptedAmount! > 0n) {
                if (!unmatchedByPair.has(pair)) {
                    unmatchedByPair.set(pair, []);
                }
                unmatchedByPair.get(pair)!.push(intent);
            }
        } else {
            // No match found, add to unmatched queue
            if (!unmatchedByPair.has(pair)) {
                unmatchedByPair.set(pair, []);
            }
            unmatchedByPair.get(pair)!.push(intent);
        }
    }

    // Collect all amounts to encrypt for matched pairs
    const amountsToEncrypt: bigint[] = [];
    for (const match of matchedPairs) {
        amountsToEncrypt.push(match.amount); // For tokenB transfer
        amountsToEncrypt.push(match.amount); // For tokenA transfer
    }

    // Batch encrypt all matched amounts in one call
    let encryptedAmounts: bigint[] = [];
    if (amountsToEncrypt.length > 0) {
        console.log(`Batch encrypting ${amountsToEncrypt.length} transfer amounts...`);
        const batchResult = await batchEncryptAmounts(amountsToEncrypt);
        encryptedAmounts = batchResult.encryptedAmounts;
    }

    // Create internal transfers from matched pairs using batch encrypted amounts
    let encryptIdx = 0;
    for (const match of matchedPairs) {
        // Transfer tokenB from userA to userB
        internalTransfers.push({
            from: match.userA,
            to: match.userB,
            encToken: match.tokenB, // This should be the encrypted token contract address
            encAmount: encryptedAmounts[encryptIdx++]
        });

        // Transfer tokenA from userB to userA
        internalTransfers.push({
            from: match.userB,
            to: match.userA,
            encToken: match.tokenA, // This should be the encrypted token contract address
            encAmount: encryptedAmounts[encryptIdx++]
        });
    }

    // Calculate net swaps for remaining unmatched intents
    let netAmountIn = 0n;
    let tokenIn = "";
    let tokenOut = "";
    const userSharesMap = new Map<string, bigint>();

    // Process all unmatched intents to find the dominant trading pair
    for (const [pair, unmatched] of unmatchedByPair.entries()) {
        if (unmatched.length > 0) {
            const [pairTokenIn, pairTokenOut] = pair.split('->');

            // Use the first pair as the primary swap direction
            if (!tokenIn) {
                tokenIn = pairTokenIn;
                tokenOut = pairTokenOut;
            }

            // Only count intents that match our primary swap direction
            if (pairTokenIn === tokenIn && pairTokenOut === tokenOut) {
                for (const intent of unmatched) {
                    netAmountIn += intent.decryptedAmount!;
                    userSharesMap.set(intent.user,
                        (userSharesMap.get(intent.user) || 0n) + intent.decryptedAmount!
                    );
                }
            }
        }
    }

    // Convert user shares to the proper format
    const userShares: UserShare[] = [];
    if (netAmountIn > 0n) {
        for (const [user, amount] of userSharesMap.entries()) {
            userShares.push({
                user,
                shareNumerator: amount,
                shareDenominator: netAmountIn
            });
        }
    }

    const outputToken = tokenOut; // The token users will receive from AMM

    console.log(`\n=== Matching Complete ===`);
    console.log(`Internal transfers: ${internalTransfers.length / 2} pairs (${internalTransfers.length} transfers)`);
    console.log(`Net AMM swap: ${netAmountIn} ${tokenIn} -> ${tokenOut}`);
    console.log(`User shares: ${userShares.length}`);

    return {
        internalTransfers,
        netAmountIn,
        tokenIn,
        tokenOut,
        outputToken,
        userShares
    }
};

const processBatch = async (batchId: string, batchData: string) => {
    try {
        console.log(`\n=== Processing Batch ${batchId} ===`);

        // Decode the batch data from SwapManager.BatchFinalized event
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ["bytes32", "bytes32[]", "address", "address", "bytes[]"],
            batchData
        );

        const [decodedBatchId, intentIds, poolId, hookAddr, encryptedIntentData] = decoded;

        console.log(`Batch ID: ${decodedBatchId}`);
        console.log(`Pool ID: ${poolId}`);
        console.log(`Hook: ${hookAddr}`);
        console.log(`Number of intents: ${encryptedIntentData.length}`);

        // Decode all encrypted intents first
        const intents: Intent[] = [];
        const encryptedAmountsToDecrypt: string[] = [];

        for (let i = 0; i < encryptedIntentData.length; i++) {
            const intentData = encryptedIntentData[i];
            const intentDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ["bytes32", "address", "address", "address", "uint256", "uint256"],
                intentData
            );

            const intent: Intent = {
                intentId: intentDecoded[0],
                user: intentDecoded[1],
                tokenIn: intentDecoded[2],
                tokenOut: intentDecoded[3],
                encryptedAmount: ethers.zeroPadValue(ethers.toBeHex(intentDecoded[4]), 32),
                deadline: BigInt(intentDecoded[5].toString())
            };

            intents.push(intent);
            encryptedAmountsToDecrypt.push(intent.encryptedAmount);
        }

        // Batch decrypt all amounts in one call
        console.log(`\nBatch decrypting ${intents.length} intents...`);
        const decryptedAmounts = await batchDecryptAmounts(encryptedAmountsToDecrypt);

        // Assign decrypted amounts back to intents
        for (let i = 0; i < intents.length; i++) {
            intents[i].decryptedAmount = decryptedAmounts[i];
            console.log(`Intent ${i + 1}: ${intents[i].user}`);
            console.log(`  ${intents[i].tokenIn} -> ${intents[i].tokenOut}`);
            console.log(`  Amount: ${intents[i].decryptedAmount}`);
        }

        // Match intents and get settlement data
        const settlementData = await matchIntents(intents);

        // Submit settlement to the hook
        console.log("\n=== Submitting Settlement to Hook ===");

        const hookABI = [
            "function settleBatch(bytes32 batchId, (address from, address to, address encToken, bytes encAmount)[] internalTransfers, uint128 netAmountIn, address tokenIn, address tokenOut, address outputToken, (address user, uint128 shareNumerator, uint128 shareDenominator)[] userShares) external"
        ];

        const hook = new ethers.Contract(hookAddr, hookABI, wallet);

        // Prepare the transaction
        const tx = await hook.settleBatch(
            decodedBatchId,
            settlementData.internalTransfers,
            settlementData.netAmountIn,
            settlementData.tokenIn,
            settlementData.tokenOut,
            settlementData.outputToken,
            settlementData.userShares
        );

        console.log(`Settlement transaction submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Settlement confirmed in block ${receipt.blockNumber}`);

        return {
            batchId: decodedBatchId,
            settlementData,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber
        };
    } catch (error) {
        console.error(`Error processing batch ${batchId}:`, error);
    }
};

const monitorBatches = async () => {
    // Listen for BatchFinalized events from SwapManager
    SwapManager.on("BatchFinalized", async (batchId: string, batchData: string, event: any) => {
        console.log(`\n🚀 New batch detected: ${batchId}`);
        console.log(`  Block: ${event.blockNumber}`);
        console.log(`  Transaction: ${event.transactionHash}`);

        // Process the batch
        await processBatch(batchId, batchData);
    });

    console.log("✅ Monitoring for new batches from SwapManager...");

    // Query past BatchFinalized events
    try {
        const filter = SwapManager.filters.BatchFinalized();
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 1000);
        const events = await SwapManager.queryFilter(filter, fromBlock, currentBlock);

        if (events.length > 0) {
            console.log(`Found ${events.length} past BatchFinalized events`);
            for (const event of events) {
                const parsedLog = SwapManager.interface.parseLog({
                    topics: event.topics as string[],
                    data: event.data
                });
                if (parsedLog) {
                    console.log(`  Past batch: ${parsedLog.args[0]}, Block: ${event.blockNumber}`);
                }
            }
        } else {
            console.log("No past BatchFinalized events found");
        }
    } catch (error) {
        console.error("Error querying past events:", error);
    }
};

const main = async () => {
    // Initialize ZAMA FHEVM for FHE operations
    await initializeFhevm(wallet);

    // Initialize UEI processor with the same wallet
    await initializeUEIProcessor(wallet);

    await registerOperator();

    // Monitor for swap batches
    monitorBatches().catch((error) => {
        console.error("Error monitoring batches:", error);
    });

    // Monitor for UEI events
    console.log("\n🔍 Starting UEI monitoring...");
    monitorUEIEvents(SwapManager, wallet.address);
};

main().catch((error) => {
    console.error("Error in main function:", error);
});
