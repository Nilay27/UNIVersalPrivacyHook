import { ethers } from 'ethers';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

let fhevmInstance: any = null;
let operatorSigner: ethers.Wallet | null = null;

export const initializeFhevm = async (signer: ethers.Wallet) => {
    try {
        operatorSigner = signer;

        // Initialize FHEVM instance for the network
        const provider = signer.provider;
        const network = await provider?.getNetwork();

        console.log("Initializing ZAMA FHEVM for network:", network?.chainId);

        // Create FHEVM instance following the CLI pattern
        // Use a network URL string, not a provider object
        const networkUrl = SepoliaConfig.network || 'https://eth-sepolia.public.blastapi.io';
        console.log("Using network URL:", networkUrl);

        const config = {
            ...SepoliaConfig,
            network: networkUrl // Must be a URL string, not a provider
        };

        fhevmInstance = await createInstance(config);

        console.log("ZAMA FHEVM initialized successfully for operator:", signer.address);
        return fhevmInstance;
    } catch (error) {
        console.error("FHEVM initialization error:", error);
        console.error("Error details:", (error as any).message);
        throw new Error("Failed to initialize ZAMA FHEVM");
    }
};

export const decryptAmount = async (encryptedAmount: string): Promise<bigint> => {
    try {
        if (!fhevmInstance || !operatorSigner) {
            throw new Error("FHEVM not initialized");
        }

        // The encryptedAmount is the FHE handle from the contract
        // It's encoded as bytes in the intent data
        let encryptedHandle: string;

        // Decode the handle from the bytes data
        if (encryptedAmount.startsWith('0x')) {
            // The encrypted amount is encoded as bytes
            // It contains the euint128 handle which is a uint256
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ["uint256"],
                encryptedAmount
            );
            encryptedHandle = decoded[0].toString();
        } else {
            encryptedHandle = encryptedAmount;
        }

        console.log(`Decrypting FHEVM handle: ${encryptedHandle}`);

        // AVS operators are granted permission to decrypt in SwapManager.finalizeBatch
        // They can decrypt the amounts to perform matching

        // For Sepolia FHEVM, operators with granted permissions can decrypt
        // This assumes the operator has been granted permission via FHE.allow()
        // The SwapManager contract grants this permission when operators process batches

        // Generate keypair for the operator to decrypt
        const { publicKey, privateKey } = fhevmInstance.generateKeypair();

        // Create the signature for decryption - operators sign to prove identity
        const contractAddresses = [process.env.SWAP_MANAGER_ADDRESS || ethers.ZeroAddress];
        const startTimestamp = Math.floor(Date.now() / 1000);
        const durationDays = 7; // Valid for 7 days

        const eip712 = fhevmInstance.createEIP712(
            publicKey,
            contractAddresses,
            startTimestamp,
            durationDays
        );

        // Sign the EIP712 message
        // Ethers expects types without EIP712Domain
        const typesWithoutDomain = { ...eip712.types };
        delete typesWithoutDomain.EIP712Domain;

        const signature = await operatorSigner.signTypedData(
            eip712.domain,
            typesWithoutDomain,
            eip712.message
        );

        // Prepare the handle for decryption
        const handleContractPair = {
            handle: encryptedHandle,
            contractAddress: contractAddresses[0]
        };

        // Use userDecrypt for operators with granted permissions
        const decryptedResults = await fhevmInstance.userDecrypt(
            [handleContractPair],
            privateKey,
            publicKey,
            signature,
            contractAddresses,
            operatorSigner.address,
            startTimestamp,
            durationDays
        );

        // Get the first (and only) result
        const decryptedValue = Object.values(decryptedResults)[0];

        console.log(`Successfully decrypted value: ${decryptedValue}`);
        return BigInt(decryptedValue as string | number | bigint);

    } catch (error) {
        console.error("Error decrypting amount:", error);
        throw error; // No fallback - fail if decryption fails
    }
};

// Single encryption (uses batch with one value)
export const encryptAmount = async (
    amount: bigint,
    userAddress?: string,
    contractAddress?: string
): Promise<bigint> => {
    const result = await batchEncryptAmounts([amount], userAddress, contractAddress);
    return result.encryptedAmounts[0];
};

// True batch encryption for multiple amounts (no loops)
// @param amounts - Array of plaintext amounts to encrypt
// @param userAddress - msg.sender when FHE.fromExternal is called (SwapManager for settlements, user for intents)
// @param contractAddress - Contract that calls FHE.fromExternal (Hook)
export const batchEncryptAmounts = async (
    amounts: bigint[],
    userAddress?: string,
    contractAddress?: string
): Promise<{
    encryptedAmounts: bigint[];
    inputProof: string;
}> => {
    try {
        if (!fhevmInstance) {
            throw new Error("FHEVM not initialized");
        }

        console.log(`Batch encrypting ${amounts.length} amounts in single call...`);

        // Addresses must be explicitly provided to ensure correct context
        // contractAddress = contract that calls FHE.fromExternal (Hook)
        // userAddress = msg.sender when fromExternal is called (SwapManager for settlements, user wallet for intents)
        if (!userAddress || !contractAddress) {
            throw new Error("userAddress and contractAddress must be provided for encryption context");
        }

        // Create single encrypted input for all values
        // Note: Zama SDK parameter order is (contractAddress, userAddress)
        const input = fhevmInstance.createEncryptedInput(
            contractAddress,
            userAddress
        );

        // Add all amounts to the same input
        for (const amount of amounts) {
            input.add128(amount);
        }

        // Encrypt all values in one call
        console.log('Calling encrypt() for batch - single relayer call...');
        const encryptedResult = await input.encrypt();
        console.log('Batch encrypt successful! Got', encryptedResult.handles?.length, 'handles');

        // Convert handles to bigint for euint128 representation
        // Each handle is a Uint8Array that represents the encrypted value's ctHash
        const encryptedAmounts = encryptedResult.handles.map((handle: Uint8Array) => {
            // Convert Uint8Array handle to bigint (ctHash)
            // This is what will be used as euint128 in the contract
            const hex = '0x' + Array.from(handle).map(b => b.toString(16).padStart(2, '0')).join('');
            return BigInt(hex);
        });

        // The input proof is shared for all encrypted values
        const inputProof = ethers.hexlify(encryptedResult.inputProof);

        console.log(`Batch encrypted ${encryptedAmounts.length} amounts as euint128 handles`);
        return {
            encryptedAmounts,
            inputProof
        };

    } catch (error) {
        console.error("Error in batch encryption:", error);
        throw error;
    }
};

// True batch decryption for multiple encrypted amounts (no loops)
export const batchDecryptAmounts = async (encryptedAmounts: string[]): Promise<bigint[]> => {
    try {
        if (!fhevmInstance || !operatorSigner) {
            throw new Error("FHEVM not initialized");
        }

        console.log(`Batch decrypting ${encryptedAmounts.length} amounts in single call...`);

        // Prepare all handles for batch decryption
        const handleContractPairs = encryptedAmounts.map((encryptedAmount, index) => {
            let encryptedHandle: string;

            console.log(`Processing encrypted amount ${index}:`, encryptedAmount);

            // Handle is already a string (uint256 as string from intent decoding)
            // Convert to hex format for FHEVM SDK, padded to 32 bytes (64 hex chars)
            if (encryptedAmount.startsWith('0x')) {
                // Already hex - validate it's proper hex
                try {
                    // Remove 0x prefix, ensure even length, then re-add 0x
                    const hexWithoutPrefix = encryptedAmount.slice(2);
                    const paddedHex = hexWithoutPrefix.padStart(64, '0');
                    encryptedHandle = '0x' + paddedHex;
                    console.log(`Padded handle ${index}:`, encryptedHandle);
                } catch (e) {
                    console.error(`Failed to pad handle ${index}:`, e);
                    throw e;
                }
            } else {
                // Convert decimal string to hex and pad to 32 bytes
                const hexValue = BigInt(encryptedAmount).toString(16).padStart(64, '0');
                encryptedHandle = '0x' + hexValue;
                console.log(`Converted handle ${index}:`, encryptedHandle);
            }

            return {
                handle: encryptedHandle,
                contractAddress: "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080" // UniversalPrivacyHook where handles were created
            };
        });

        // Generate keypair once for all decryptions
        const { publicKey, privateKey } = fhevmInstance.generateKeypair();

        // Create signature once for batch
        const contractAddresses = ["0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080"]; // UniversalPrivacyHook
        const startTimestamp = Math.floor(Date.now() / 1000);
        const durationDays = 7;

        const eip712 = fhevmInstance.createEIP712(
            publicKey,
            contractAddresses,
            startTimestamp,
            durationDays
        );

        const typesWithoutDomain = { ...eip712.types };
        delete typesWithoutDomain.EIP712Domain;

        const signature = await operatorSigner.signTypedData(
            eip712.domain,
            typesWithoutDomain,
            eip712.message
        );

        // Decrypt all values in one call
        const decryptedResults = await fhevmInstance.userDecrypt(
            handleContractPairs,
            privateKey,
            publicKey,
            signature,
            contractAddresses,
            operatorSigner.address,
            startTimestamp,
            durationDays
        );

        // Extract results in order
        const results = Object.values(decryptedResults).map(value => BigInt(value as string | number | bigint));

        console.log(`Successfully batch decrypted ${results.length} amounts in one call`);
        return results;

    } catch (error) {
        console.error("Error in batch decryption:", error);
        throw error;
    }
};

// Helper function to decrypt and process a swap task
export const decryptSwapTask = async (task: any): Promise<{
    decryptedAmount: bigint;
    tokenIn: string;
    tokenOut: string;
    user: string;
}> => {
    console.log("Decrypting swap task...");

    // Decrypt the encrypted amount
    const decryptedAmount = await decryptAmount(task.encryptedAmount);

    return {
        decryptedAmount,
        tokenIn: task.tokenIn,
        tokenOut: task.tokenOut,
        user: task.user
    };
};

// Batch decrypt swap tasks
export const batchDecryptSwapTasks = async (tasks: any[]): Promise<Array<{
    decryptedAmount: bigint;
    tokenIn: string;
    tokenOut: string;
    user: string;
    taskIndex?: number;
}>> => {
    console.log(`Batch decrypting ${tasks.length} swap tasks...`);

    // Extract encrypted amounts for batch processing
    const encryptedAmounts = tasks.map(task => task.encryptedAmount);

    // Batch decrypt all amounts
    const decryptedAmounts = await batchDecryptAmounts(encryptedAmounts);

    // Combine with task metadata
    return tasks.map((task, index) => ({
        decryptedAmount: decryptedAmounts[index],
        tokenIn: task.tokenIn,
        tokenOut: task.tokenOut,
        user: task.user,
        taskIndex: task.taskIndex
    }));
};

// Helper to match and net orders for optimized execution
export const matchAndNetOrders = (orders: Array<{
    user: string;
    tokenIn: string;
    tokenOut: string;
    decryptedAmount: bigint;
}>): Map<string, {
    tokenIn: string;
    tokenOut: string;
    totalAmount: bigint;
    orders: typeof orders;
}> => {
    const netOrders = new Map();

    for (const order of orders) {
        const pair = `${order.tokenIn}->${order.tokenOut}`;

        if (!netOrders.has(pair)) {
            netOrders.set(pair, {
                tokenIn: order.tokenIn,
                tokenOut: order.tokenOut,
                totalAmount: BigInt(0),
                orders: []
            });
        }

        const net = netOrders.get(pair)!;
        net.totalAmount += order.decryptedAmount;
        net.orders.push(order);
    }

    // Log the netting results
    console.log("\nOrder Netting Results:");
    console.log("======================");
    for (const [pair, net] of netOrders.entries()) {
        const displayAmount = net.tokenIn === 'WETH'
            ? `${Number(net.totalAmount) / 1e18} ETH`
            : `${Number(net.totalAmount) / 1e6} USDC/USDT`;

        console.log(`${pair}:`);
        console.log(`  Total: ${displayAmount}`);
        console.log(`  Orders: ${net.orders.length} (from ${net.orders.map((o: any) => o.user).join(', ')})`);
    }

    return netOrders;
};