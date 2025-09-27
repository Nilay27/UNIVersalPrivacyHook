/**
 * Enhanced UEI Task Generator with Batched FHE Encryption
 * 
 * This module creates Universal Execution Intent (UEI) tasks with optimized batch encryption:
 * 
 * Key Features:
 * - Batch encryption of all UEI components (decoder, target, selector, args) in a single call
 * - Type-specific FHE encryption: eaddress for addresses, euint32 for selectors, euint256 for args
 * - Batch creation of multiple UEI intents with shared input proofs
 * - Batch decryption support for operators
 * - Fallback compatibility with existing contract methods
 * 
 * Encryption Types:
 * - decoder, target → eaddress (address type)
 * - selector → euint32 (4-byte function selector)
 * - args → euint256[] (widened from smaller types for uniformity)
 * - argTypes → unencrypted uint8[] (type information is not sensitive)
 * 
 * Performance Benefits:
 * - Single relayer call for all components vs multiple individual calls
 * - Shared input proof across all encrypted values
 * - Reduced gas costs and improved throughput
 * 
 * Complete Flow:
 * 1. Batch encrypt UEI components (decoder, target, selector, args)
 * 2. Submit encrypted blob to contract with input proof
 * 3. Operators read blob from contract and parse encrypted handles
 * 4. Operators batch decrypt all components with proper permissions
 * 5. Operators interpret arguments based on type information
 * 6. Operators execute the reconstructed function calls
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { initializeFhevm, encryptAmount } from './fhevmUtils';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

dotenv.config();

const PROVIDER_URL = process.env.RPC_URL || 'http://localhost:8545';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Argument types
enum ArgType {
    ADDR = 0,
    U256 = 1,
    U16 = 2,
    U32 = 3,
    U64 = 4,
    U128 = 5
}

// Example trade strategies - focusing on Aave and basic token operations
const TRADE_STRATEGIES = [
    {
        name: "Aave Supply USDC",
        decoder: "0x0000000000000000000000000000000000DEC0",  // Mock Aave decoder
        target: "0x0000000000000000000000000000000000AA7E",   // Mock Aave pool
        selector: "0x617ba037",  // supply(address,uint256,address,uint16)
        argTypes: [ArgType.ADDR, ArgType.U256, ArgType.ADDR, ArgType.U16],
        args: [
            "0x0000000000000000000000000000000000000001",  // USDC token
            "1000000000",  // 1000 USDC (6 decimals)
            null,  // Will use boringVault address
            "0"    // No referral
        ]
    },
    {
        name: "Aave Supply USDT",
        decoder: "0x0000000000000000000000000000000000DEC0",  // Mock Aave decoder
        target: "0x0000000000000000000000000000000000AA7E",   // Mock Aave pool
        selector: "0x617ba037",  // supply(address,uint256,address,uint16)
        argTypes: [ArgType.ADDR, ArgType.U256, ArgType.ADDR, ArgType.U16],
        args: [
            "0x0000000000000000000000000000000000000002",  // USDT token
            "500000000",   // 500 USDT (6 decimals)
            null,  // Will use boringVault address
            "0"    // No referral
        ]
    },
    {
        name: "Aave Supply DAI",
        decoder: "0x0000000000000000000000000000000000DEC0",  // Mock Aave decoder
        target: "0x0000000000000000000000000000000000AA7E",   // Mock Aave pool
        selector: "0x617ba037",  // supply(address,uint256,address,uint16)
        argTypes: [ArgType.ADDR, ArgType.U256, ArgType.ADDR, ArgType.U16],
        args: [
            "0x0000000000000000000000000000000000000003",  // DAI token
            "2000000000000000000000",  // 2000 DAI (18 decimals)
            null,  // Will use boringVault address
            "0"    // No referral
        ]
    },
    {
        name: "USDC Approve to Aave",
        decoder: "0x0000000000000000000000000000000000DEC1",  // Mock ERC20 decoder
        target: "0x0000000000000000000000000000000000000001",   // USDC token
        selector: "0x095ea7b3",  // approve(address,uint256)
        argTypes: [ArgType.ADDR, ArgType.U256],
        args: [
            "0x0000000000000000000000000000000000AA7E",  // Aave pool
            "1000000000000"  // 1M USDC approval
        ]
    },
    {
        name: "USDC Transfer",
        decoder: "0x0000000000000000000000000000000000DEC1",  // Mock ERC20 decoder
        target: "0x0000000000000000000000000000000000000001",   // USDC token
        selector: "0xa9059cbb",  // transfer(address,uint256)
        argTypes: [ArgType.ADDR, ArgType.U256],
        args: [
            "0x0000000000000000000000000000000000001234",  // Recipient
            "100000000"  // 100 USDC
        ]
    }
];

// Initialize FHEVM instance globally for UEI encryption
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

// Batch encrypt all UEI components in a single call
async function batchEncryptUEIComponents(
    decoder: string,
    target: string, 
    selector: string,
    args: (string | number)[],
    contractAddress: string,
    signerAddress: string
): Promise<{
    encryptedDecoder: any;
    encryptedTarget: any;
    encryptedSelector: any;
    encryptedArgs: any[];
    inputProof: string;
}> {
    try {
        console.log(`Batch encrypting UEI components: decoder, target, selector, and ${args.length} args`);

        // Use the initialized FHEVM instance
        const fhevm = await initializeFhevmInstance();

        const encryptedInput = fhevm.createEncryptedInput(contractAddress, signerAddress);

        // Add decoder as eaddress (address type)
        const decoderBigInt = BigInt(decoder);
        encryptedInput.addAddress(ethers.getAddress(ethers.toBeHex(decoderBigInt, 20)));

        // Add target as eaddress (address type)  
        const targetBigInt = BigInt(target);
        encryptedInput.addAddress(ethers.getAddress(ethers.toBeHex(targetBigInt, 20)));

        // Add selector as euint32 (4-byte function selector)
        const selectorBigInt = BigInt(selector);
        encryptedInput.add32(Number(selectorBigInt & BigInt(0xFFFFFFFF)));

        // Add all args as euint256 (widening smaller types)
        for (const arg of args) {
            let argBigInt: bigint;
            if (typeof arg === 'string' && arg.startsWith('0x')) {
                argBigInt = BigInt(arg);
            } else {
                argBigInt = BigInt(arg);
            }
            encryptedInput.add256(argBigInt);
        }

        // Encrypt all values in one call
        const encrypted = await encryptedInput.encrypt();

        console.log("Batch encrypted all UEI components successfully");
        console.log("Encrypted handles count:", encrypted.handles.length);
        console.log("Input proof length:", encrypted.inputProof.length, "bytes");

        return {
            encryptedDecoder: encrypted.handles[0],
            encryptedTarget: encrypted.handles[1], 
            encryptedSelector: encrypted.handles[2],
            encryptedArgs: encrypted.handles.slice(3), // Remaining handles are args
            inputProof: ethers.hexlify(encrypted.inputProof)
        };
    } catch (error) {
        console.error("Error in batch UEI encryption:", error);
        throw error;
    }
}

// Legacy single encryption function (kept for compatibility)
async function encryptUEIComponent(value: string | number): Promise<bigint> {
    // Convert to bigint for encryption
    let bigIntValue: bigint;

    if (typeof value === 'string' && value.startsWith('0x')) {
        // For addresses/hex values, convert to bigint
        bigIntValue = BigInt(value);
    } else if (typeof value === 'string') {
        // For numeric strings
        bigIntValue = BigInt(value);
    } else {
        // For numbers
        bigIntValue = BigInt(value);
    }

    // encryptAmount now returns bigint directly (euint128 handle/ctHash)
    const encrypted = await encryptAmount(bigIntValue);
    return encrypted;
}

async function createEncryptedUEI(provider: ethers.Provider, wallet: ethers.Wallet) {
    try {
        console.log("🔐 Creating Encrypted Universal Intent (UEI)...\n");

        // Load contract addresses
        const deploymentPath = './contracts/deployments/swap-manager/31337.json';
        const mockHookDeploymentPath = './contracts/deployments/mock-hook/31337.json';

        if (!fs.existsSync(deploymentPath) || !fs.existsSync(mockHookDeploymentPath)) {
            console.error('Deployment files not found. Please run deployment first.');
            return;
        }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    const mockHookDeployment = JSON.parse(fs.readFileSync(mockHookDeploymentPath, 'utf8'));

    const swapManagerAddress = deployment.addresses.SwapManager;
    const mockHookAddress = mockHookDeployment.addresses.mockPrivacyHook;
    const boringVaultAddress = mockHookDeployment.addresses.boringVault || "0x0000000000000000000000000000000000B041";

    console.log("SwapManager:", swapManagerAddress);
    console.log("MockPrivacyHook:", mockHookAddress);
    console.log("BoringVault:", boringVaultAddress);

    // Load ABIs
    const mockHookAbi = JSON.parse(fs.readFileSync('./abis/MockPrivacyHook.json', 'utf8'));
    const swapManagerAbi = JSON.parse(fs.readFileSync('./abis/SwapManager.json', 'utf8'));

    // Create contract instances
    const mockHook = new ethers.Contract(mockHookAddress, mockHookAbi, wallet);
    const swapManager = new ethers.Contract(swapManagerAddress, swapManagerAbi, wallet);

    // Select a strategy (weighted towards Aave supply)
    const random = Math.random();
    let strategy;
    if (random < 0.6) {
        // 60% chance of Aave supply operations
        strategy = TRADE_STRATEGIES[Math.floor(Math.random() * 3)]; // First 3 are Aave supplies
    } else if (random < 0.8) {
        // 20% chance of approve
        strategy = TRADE_STRATEGIES[3];
    } else {
        // 20% chance of transfer
        strategy = TRADE_STRATEGIES[4];
    }

    console.log(`\n📊 Selected Strategy: ${strategy.name}`);

    // Prepare arguments, replacing null with boringVault address
    const preparedArgs = strategy.args.map(arg => {
        if (arg === null) {
            return boringVaultAddress;
        }
        if (arg === null || arg === undefined) {
            throw new Error(`Argument is null or undefined`);
        }
        return arg;
    });

    // Initialize FHEVM instance for batch encryption
    await initializeFhevmInstance();

    // Batch encrypt all UEI components in a single call
    console.log("\n🔐 Batch encrypting all UEI components...");
    const batchEncrypted = await batchEncryptUEIComponents(
        strategy.decoder,
        strategy.target,
        strategy.selector,
        preparedArgs,
        mockHookAddress, // Contract address for encryption context
        wallet.address   // Signer address
    );

    console.log("  ✅ Encrypted decoder handle");
    console.log("  ✅ Encrypted target handle");
    console.log("  ✅ Encrypted selector handle");
    console.log(`  ✅ Encrypted ${batchEncrypted.encryptedArgs.length} argument handles`);
    console.log(`  ✅ Generated input proof (${batchEncrypted.inputProof.length} chars)`);

    // Convert handles to the format expected by the contract
    const ctDecoder = batchEncrypted.encryptedDecoder;
    const ctTarget = batchEncrypted.encryptedTarget;
    const ctSelector = batchEncrypted.encryptedSelector;
    const ctArgs = batchEncrypted.encryptedArgs;

        // Create the blob with encrypted handles (keeping argTypes unencrypted as they're not sensitive)
        const ctBlob = ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32', 'bytes32', 'uint8[]', 'bytes32[]'],
            [
                ethers.hexlify(ctDecoder), // eaddress handle
                ethers.hexlify(ctTarget),  // eaddress handle  
                ethers.hexlify(ctSelector), // euint32 handle
                strategy.argTypes, // Keep argTypes unencrypted (not sensitive)
                ctArgs.map(handle => ethers.hexlify(handle)) // euint256 handles
            ]
        );

        console.log("\n📦 Created encrypted blob with FHE handles");
        console.log("  Blob size:", ctBlob.length, "bytes");
        console.log("  Input proof size:", batchEncrypted.inputProof.length, "chars");

        // Submit UEI through MockPrivacyHook with input proof
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

        console.log("\n📤 Submitting UEI to MockPrivacyHook...");
        console.log("  Blob size:", ctBlob.length, "bytes");
        console.log("  Deadline:", deadline);

        // Get current nonce to avoid nonce issues
        const nonce = await wallet.getNonce();
        console.log("  Using nonce:", nonce);

        // Try to submit with input proof if the method exists, otherwise fallback to original method
        let tx;
        try {
            // Try the new method with input proof first
            tx = await mockHook.submitUEIBlobWithProof(
                ctBlob, 
                batchEncrypted.inputProof, 
                deadline, 
                { nonce }
            );
        } catch (error: any) {
            if (error.message?.includes('submitUEIBlobWithProof')) {
                console.log("  ⚠️  submitUEIBlobWithProof not available, using original method");
                // Fallback to original method
                tx = await mockHook.submitUEIBlob(ctBlob, deadline, { nonce });
            } else {
                throw error;
            }
        }
        console.log("Transaction hash:", tx.hash);

        const receipt = await tx.wait();
        console.log("✅ UEI submitted successfully!");

        // Extract intent ID from events
        const ueiEvent = receipt.logs.find((log: any) => {
            try {
                const parsed = mockHook.interface.parseLog(log);
                return parsed && parsed.name === 'UEISubmitted';
            } catch {
                return false;
            }
        });

        if (ueiEvent) {
            const parsedEvent = mockHook.interface.parseLog(ueiEvent);
            const intentId = parsedEvent?.args[0];
            console.log("\n🎯 Intent ID:", intentId);

            // Check if task was created in SwapManager
            const task = await swapManager.getUEITask(intentId);
            console.log("\n📋 UEI Task Details:");
            console.log("  Submitter:", task.submitter);
            console.log("  Deadline:", new Date(Number(task.deadline) * 1000).toLocaleString());
            console.log("  Status:", ["Pending", "Processing", "Executed", "Failed", "Expired"][task.status]);
            console.log("  Selected Operators:", task.selectedOperators.length);

            if (task.selectedOperators.length > 0) {
                console.log("\n👥 Selected Operators:");
                task.selectedOperators.forEach((op: string, i: number) => {
                    console.log(`    ${i + 1}. ${op}`);
                });
            }
        }
    } catch (error) {
        console.error("Failed to create UEI:", error);
    }
}

// Batch create multiple UEI intents at once
async function createBatchEncryptedUEIs(
    provider: ethers.Provider, 
    wallet: ethers.Wallet, 
    batchSize: number = 3
) {
    try {
        console.log(`\n🔐 Creating Batch of ${batchSize} Encrypted UEIs...\n`);

        // Load contract addresses
        const deploymentPath = './contracts/deployments/swap-manager/31337.json';
        const mockHookDeploymentPath = './contracts/deployments/mock-hook/31337.json';

        if (!fs.existsSync(deploymentPath) || !fs.existsSync(mockHookDeploymentPath)) {
            console.error('Deployment files not found. Please run deployment first.');
            return;
        }

        const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
        const mockHookDeployment = JSON.parse(fs.readFileSync(mockHookDeploymentPath, 'utf8'));

        const swapManagerAddress = deployment.addresses.SwapManager;
        const mockHookAddress = mockHookDeployment.addresses.mockPrivacyHook;
        const boringVaultAddress = mockHookDeployment.addresses.boringVault || "0x0000000000000000000000000000000000B041";

        // Load ABIs
        const mockHookAbi = JSON.parse(fs.readFileSync('./abis/MockPrivacyHook.json', 'utf8'));
        const mockHook = new ethers.Contract(mockHookAddress, mockHookAbi, wallet);

        // Initialize FHEVM instance
        await initializeFhevmInstance();

        const submittedIntentIds: string[] = [];

        // Create multiple UEIs in batch
        for (let i = 0; i < batchSize; i++) {
            // Select different strategies for variety
            const strategyIndex = i % TRADE_STRATEGIES.length;
            const strategy = TRADE_STRATEGIES[strategyIndex];

            console.log(`\n📊 Batch UEI ${i + 1}/${batchSize}: ${strategy.name}`);

            // Prepare arguments
            const preparedArgs = strategy.args.map(arg => {
                if (arg === null) return boringVaultAddress;
                if (arg === null || arg === undefined) {
                    throw new Error(`Argument is null or undefined`);
                }
                return arg;
            });

            // Batch encrypt all components for this UEI
            const batchEncrypted = await batchEncryptUEIComponents(
                strategy.decoder,
                strategy.target,
                strategy.selector,
                preparedArgs,
                mockHookAddress,
                wallet.address
            );

            // Create blob
            const ctBlob = ethers.AbiCoder.defaultAbiCoder().encode(
                ['bytes32', 'bytes32', 'bytes32', 'uint8[]', 'bytes32[]'],
                [
                    ethers.hexlify(batchEncrypted.encryptedDecoder),
                    ethers.hexlify(batchEncrypted.encryptedTarget),
                    ethers.hexlify(batchEncrypted.encryptedSelector),
                    strategy.argTypes,
                    batchEncrypted.encryptedArgs.map(handle => ethers.hexlify(handle))
                ]
            );

            // Submit UEI
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const nonce = await wallet.getNonce();

            let tx;
            try {
                tx = await mockHook.submitUEIBlobWithProof(
                    ctBlob, 
                    batchEncrypted.inputProof, 
                    deadline, 
                    { nonce }
                );
            } catch (error: any) {
                if (error.message?.includes('submitUEIBlobWithProof')) {
                    tx = await mockHook.submitUEIBlob(ctBlob, deadline, { nonce });
                } else {
                    throw error;
                }
            }

            const receipt = await tx.wait();
            console.log(`  ✅ UEI ${i + 1} submitted: ${tx.hash}`);

            // Extract intent ID
            const ueiEvent = receipt.logs.find((log: any) => {
                try {
                    const parsed = mockHook.interface.parseLog(log);
                    return parsed && parsed.name === 'UEISubmitted';
                } catch {
                    return false;
                }
            });

            if (ueiEvent) {
                const parsedEvent = mockHook.interface.parseLog(ueiEvent);
                const intentId = parsedEvent?.args[0];
                submittedIntentIds.push(intentId);
                console.log(`  🎯 Intent ID: ${intentId}`);
            }

            // Small delay between submissions
            if (i < batchSize - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`\n✅ Batch completed! Submitted ${submittedIntentIds.length} UEI intents`);
        return submittedIntentIds;

    } catch (error) {
        console.error("Failed to create batch UEIs:", error);
    }
}

// Read and parse UEI blob from contract to extract encrypted handles
async function readAndParseUEIBlob(
    intentId: string,
    contractAddress: string,
    contractAbi: any,
    provider: ethers.Provider
): Promise<{
    encryptedDecoder: string;
    encryptedTarget: string;
    encryptedSelector: string;
    encryptedArgs: string[];
    argTypes: number[];
}> {
    try {
        console.log(`Reading UEI blob for intent ID: ${intentId}`);

        const contract = new ethers.Contract(contractAddress, contractAbi, provider);

        // Read the UEI task/intent from the contract
        // This assumes the contract has a method to get UEI data by intent ID
        let ueiData;
        try {
            ueiData = await contract.getUEITask(intentId);
        } catch (error) {
            // Try alternative method names
            try {
                ueiData = await contract.getUEI(intentId);
            } catch {
                ueiData = await contract.ueiTasks(intentId);
            }
        }

        if (!ueiData || !ueiData.ctBlob) {
            throw new Error(`UEI data not found for intent ID: ${intentId}`);
        }

        const ctBlob = ueiData.ctBlob;
        console.log(`Found UEI blob: ${ctBlob.length} bytes`);

        // Decode the blob according to our encoding format
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['bytes32', 'bytes32', 'bytes32', 'uint8[]', 'bytes32[]'],
            ctBlob
        );

        const [encryptedDecoder, encryptedTarget, encryptedSelector, argTypes, encryptedArgs] = decoded;

        console.log(`Parsed UEI blob: decoder, target, selector + ${encryptedArgs.length} args`);

        return {
            encryptedDecoder,
            encryptedTarget,
            encryptedSelector,
            encryptedArgs,
            argTypes: argTypes.map((t: any) => Number(t))
        };

    } catch (error) {
        console.error("Error reading/parsing UEI blob:", error);
        throw error;
    }
}

// Batch decrypt UEI components (for operators) - now reads blob from contract first
async function batchDecryptUEIFromContract(
    intentId: string,
    contractAddress: string,
    contractAbi: any,
    provider: ethers.Provider,
    operatorWallet: ethers.Wallet
): Promise<{
    decoder: string;
    target: string;
    selector: string;
    args: (string | bigint)[];
    argTypes: number[];
}> {
    try {
        console.log(`Batch decrypting UEI for intent ID: ${intentId}`);

        // Step 1: Read and parse the UEI blob from the contract
        const parsedBlob = await readAndParseUEIBlob(intentId, contractAddress, contractAbi, provider);

        // Step 2: Batch decrypt all encrypted components
        const decrypted = await batchDecryptUEIComponents(
            parsedBlob.encryptedDecoder,
            parsedBlob.encryptedTarget,
            parsedBlob.encryptedSelector,
            parsedBlob.encryptedArgs,
            contractAddress,
            operatorWallet.address
        );

        return {
            ...decrypted,
            argTypes: parsedBlob.argTypes
        };

    } catch (error) {
        console.error("Error in batch UEI decryption from contract:", error);
        throw error;
    }
}

// Batch decrypt UEI components (for operators) - now expects pre-extracted handles
async function batchDecryptUEIComponents(
    encryptedDecoder: string,
    encryptedTarget: string,
    encryptedSelector: string,
    encryptedArgs: string[],
    contractAddress: string,
    signerAddress: string
): Promise<{
    decoder: string;
    target: string;
    selector: string;
    args: (string | bigint)[];
}> {
    try {
        console.log("Batch decrypting UEI components...");

        const fhevm = await initializeFhevmInstance();

        // Prepare all handles for batch decryption
        const handleContractPairs = [
            { handle: encryptedDecoder, contractAddress },
            { handle: encryptedTarget, contractAddress },
            { handle: encryptedSelector, contractAddress },
            ...encryptedArgs.map(handle => ({ handle, contractAddress }))
        ];

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

        // This would need to be signed by an authorized operator
        const signature = await (new ethers.Wallet(process.env.PRIVATE_KEY!, new ethers.JsonRpcProvider())).signTypedData(
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
            signerAddress,
            startTimestamp,
            durationDays
        );

        const results = Object.values(decryptedResults);

        // Convert results back to appropriate types
        const decoder = ethers.getAddress(ethers.toBeHex(BigInt(results[0] as any), 20));
        const target = ethers.getAddress(ethers.toBeHex(BigInt(results[1] as any), 20));
        const selector = `0x${Number(results[2]).toString(16).padStart(8, '0')}`; // euint32 -> hex string
        const args = results.slice(3).map(val => BigInt(val as any)); // euint256 -> bigint

        console.log("✅ Batch decrypted UEI components");
        return { decoder, target, selector, args };

    } catch (error) {
        console.error("Error in batch UEI decryption:", error);
        throw error;
    }
}

async function monitorUEIEvents(provider: ethers.Provider) {
    console.log("\n👀 Monitoring for UEI events...\n");

    const deploymentPath = './contracts/deployments/swap-manager/31337.json';
    if (!fs.existsSync(deploymentPath)) {
        console.error('Deployment file not found');
        return;
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    const swapManagerAddress = deployment.addresses.SwapManager;
    const swapManagerAbi = JSON.parse(fs.readFileSync('./abis/SwapManager.json', 'utf8'));

    const swapManager = new ethers.Contract(swapManagerAddress, swapManagerAbi, provider);

    // Listen for UEI events
    swapManager.on("UEISubmitted", (intentId, submitter, ctBlob, deadline, selectedOperators) => {
        console.log("\n🚀 New UEI Submitted!");
        console.log("  Intent ID:", intentId);
        console.log("  Submitter:", submitter);
        console.log("  Deadline:", new Date(Number(deadline) * 1000).toLocaleString());
        console.log("  Selected Operators:", selectedOperators.length);
    });

    swapManager.on("UEIProcessed", (intentId, success, result) => {
        console.log("\n✅ UEI Processed!");
        console.log("  Intent ID:", intentId);
        console.log("  Success:", success);
        if (result && result.length > 0 && result !== '0x') {
            console.log("  Result:", result);
        }
    });
}

// Demonstration: Complete operator flow for processing a UEI intent
async function demonstrateOperatorUEIProcessing(
    intentId: string,
    provider: ethers.Provider,
    operatorWallet: ethers.Wallet
) {
    try {
        console.log(`\n🔍 Operator Processing UEI Intent: ${intentId}`);
        console.log("=" .repeat(50));

        // Load contract addresses and ABIs
        const deploymentPath = './contracts/deployments/swap-manager/31337.json';
        const mockHookDeploymentPath = './contracts/deployments/mock-hook/31337.json';

        if (!fs.existsSync(deploymentPath) || !fs.existsSync(mockHookDeploymentPath)) {
            console.error('Deployment files not found');
            return;
        }

        const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
        const mockHookDeployment = JSON.parse(fs.readFileSync(mockHookDeploymentPath, 'utf8'));

        const swapManagerAddress = deployment.addresses.SwapManager;
        const mockHookAddress = mockHookDeployment.addresses.mockPrivacyHook;

        const mockHookAbi = JSON.parse(fs.readFileSync('./abis/MockPrivacyHook.json', 'utf8'));
        const swapManagerAbi = JSON.parse(fs.readFileSync('./abis/SwapManager.json', 'utf8'));

        console.log(`📋 Contract Addresses:`);
        console.log(`   SwapManager: ${swapManagerAddress}`);
        console.log(`   MockHook: ${mockHookAddress}`);

        // Step 1: Read and decrypt the UEI from the contract
        console.log(`\n🔓 Step 1: Reading and decrypting UEI...`);
        
        let decryptedUEI;
        try {
            // Try SwapManager first
            decryptedUEI = await batchDecryptUEIFromContract(
                intentId,
                swapManagerAddress,
                swapManagerAbi,
                provider,
                operatorWallet
            );
        } catch (error) {
            console.log(`   ⚠️  SwapManager read failed, trying MockHook...`);
            // Fallback to MockHook
            decryptedUEI = await batchDecryptUEIFromContract(
                intentId,
                mockHookAddress,
                mockHookAbi,
                provider,
                operatorWallet
            );
        }

        // Step 2: Display decrypted UEI details
        console.log(`\n📊 Step 2: Decrypted UEI Details:`);
        console.log(`   Decoder: ${decryptedUEI.decoder}`);
        console.log(`   Target: ${decryptedUEI.target}`);
        console.log(`   Selector: ${decryptedUEI.selector}`);
        console.log(`   Arg Types: [${decryptedUEI.argTypes.join(', ')}]`);
        console.log(`   Args: [${decryptedUEI.args.map(arg => arg.toString()).join(', ')}]`);

        // Step 3: Interpret the arguments based on their types
        console.log(`\n🔍 Step 3: Interpreting Arguments:`);
        const interpretedArgs = decryptedUEI.args.map((arg, index) => {
            const argType = decryptedUEI.argTypes[index];
            switch (argType) {
                case ArgType.ADDR:
                    const address = ethers.getAddress(ethers.toBeHex(arg as bigint, 20));
                    console.log(`   Arg[${index}] (ADDR): ${address}`);
                    return address;
                case ArgType.U256:
                    console.log(`   Arg[${index}] (U256): ${arg.toString()}`);
                    return arg;
                case ArgType.U16:
                    const u16Value = Number(arg as bigint) & 0xFFFF;
                    console.log(`   Arg[${index}] (U16): ${u16Value}`);
                    return u16Value;
                case ArgType.U32:
                    const u32Value = Number(arg as bigint) & 0xFFFFFFFF;
                    console.log(`   Arg[${index}] (U32): ${u32Value}`);
                    return u32Value;
                case ArgType.U64:
                    const u64Value = Number(arg as bigint) & 0xFFFFFFFFFFFFFFFF;
                    console.log(`   Arg[${index}] (U64): ${u64Value}`);
                    return u64Value;
                case ArgType.U128:
                    console.log(`   Arg[${index}] (U128): ${arg.toString()}`);
                    return arg;
                default:
                    console.log(`   Arg[${index}] (Unknown): ${arg.toString()}`);
                    return arg;
            }
        });

        // Step 4: Reconstruct the function call
        console.log(`\n🔧 Step 4: Reconstructed Function Call:`);
        console.log(`   Target Contract: ${decryptedUEI.target}`);
        console.log(`   Function Selector: ${decryptedUEI.selector}`);
        console.log(`   Decoded Arguments: [${interpretedArgs.join(', ')}]`);

        // Step 5: Simulate execution (in a real scenario, the operator would execute this)
        console.log(`\n⚡ Step 5: Execution Simulation:`);
        console.log(`   Would call: ${decryptedUEI.target}.${decryptedUEI.selector}(${interpretedArgs.join(', ')})`);
        console.log(`   Decoder would handle: ${decryptedUEI.decoder}`);

        console.log(`\n✅ UEI Processing Complete!`);
        console.log("=" .repeat(50));

        return {
            intentId,
            decryptedUEI,
            interpretedArgs
        };

    } catch (error) {
        console.error(`❌ Error processing UEI ${intentId}:`, error);
        throw error;
    }
}

async function main() {
    const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log("👤 User wallet:", wallet.address);

    // Initialize ZAMA FHEVM for FHE operations
    console.log("\n🔐 Initializing ZAMA FHEVM encryption...");
    await initializeFhevm(wallet);
    console.log("✅ ZAMA FHEVM encryption initialized\n");

    // Start monitoring
    monitorUEIEvents(provider);

    // Create UEIs periodically - now with batch support
    const createUEI = async () => {
        // Randomly choose between single UEI or batch
        const useBatch = Math.random() > 0.5;
        
        if (useBatch) {
            console.log("\n🔄 Creating batch UEIs...");
            await createBatchEncryptedUEIs(provider, wallet, 3);
        } else {
            console.log("\n🔄 Creating single UEI...");
            await createEncryptedUEI(provider, wallet);
        }
    };

    // Create first batch immediately and demonstrate operator processing
    console.log("\n🚀 Creating initial batch of UEIs...");
    const initialIntentIds = await createBatchEncryptedUEIs(provider, wallet, 2);

    // Demonstrate operator processing on the first created intent
    if (initialIntentIds && initialIntentIds.length > 0) {
        console.log("\n🔄 Demonstrating operator processing...");
        setTimeout(async () => {
            try {
                await demonstrateOperatorUEIProcessing(initialIntentIds[0], provider, wallet);
            } catch (error: any) {
                console.log("⚠️  Operator processing demo failed (expected if contract methods differ):", error.message);
            }
        }, 5000); // Wait 5 seconds for the UEI to be stored
    }

    // Then create UEIs every 45 seconds (increased interval for batches)
    setInterval(createUEI, 45000);

    console.log("\n⏰ Will create new UEIs (single or batch) every 45 seconds...");
    console.log("💡 Operator processing demo will run on first created UEI");
    console.log("Press Ctrl+C to stop\n");
}

main().catch(console.error);