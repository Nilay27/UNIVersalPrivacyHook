/**
 * Create Encrypted UEI Tasks - Simplified for Testing
 *
 * This script submits a simple USDC transfer UEI to the SwapManager
 * Flow:
 * 1. Encrypt: decoder (address), target (USDC), selector (transfer), args [recipient, amount]
 * 2. Submit to SwapManager.submitEncryptedUEI(ctBlob, inputProof, deadline)
 * 3. Wait for batch finalization (handled by keeper or manual call)
 * 4. Operator will decrypt and process (handled by ueiProcessor.ts)
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

dotenv.config();

const PROVIDER_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_KEY';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

// Sepolia testnet addresses
const SWAP_MANAGER = '0xE1e00b5d08a08Cb141a11a922e48D4c06d66D3bf';
const BORING_VAULT = '0x4D2a5229C238EEaF5DB0912eb4BE7c39575369f0';
const USDC_SEPOLIA = '0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1'; // Sepolia USDC

// Mock decoder for ERC20 transfers (for testing - in production would be verified via merkle tree)
// Using a valid address format - decoder validation will be added with merkle tree in BoringVault
const MOCK_ERC20_DECODER = '0x0000000000000000000000000000000000000001';

// Initialize FHEVM instance
let fhevmInstance: any = null;

async function initializeFhevmInstance() {
    if (!fhevmInstance) {
        console.log("Creating FHEVM instance for encryption...");
        fhevmInstance = await createInstance({
            ...SepoliaConfig,
            network: PROVIDER_URL
        });
        console.log("✅ FHEVM instance created");
    }
    return fhevmInstance;
}

/**
 * Batch encrypt all UEI components
 * NEW FORMAT: No argTypes! All args are euint256
 */
async function batchEncryptUEIComponents(
    decoder: string,
    target: string,
    selector: string,
    args: (string | bigint)[],
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
        console.log("🔐 Batch encrypting UEI components...");
        console.log(`  Decoder: ${decoder}`);
        console.log(`  Target: ${target}`);
        console.log(`  Selector: ${selector}`);
        console.log(`  Args (${args.length}):`, args);

        const fhevm = await initializeFhevmInstance();
        const encryptedInput = fhevm.createEncryptedInput(contractAddress, signerAddress);

        // Encrypt decoder as eaddress
        encryptedInput.addAddress(ethers.getAddress(decoder));

        // Encrypt target as eaddress
        encryptedInput.addAddress(ethers.getAddress(target));

        // Encrypt selector as euint32
        const selectorBigInt = BigInt(selector);
        encryptedInput.add32(Number(selectorBigInt & BigInt(0xFFFFFFFF)));

        // Encrypt all args as euint256 (NO argTypes!)
        for (const arg of args) {
            const argBigInt = typeof arg === 'string' ? BigInt(arg) : arg;
            encryptedInput.add256(argBigInt);
        }

        // Encrypt all in one call
        const encrypted = await encryptedInput.encrypt();

        console.log("✅ Encrypted components:");
        console.log(`  Total handles: ${encrypted.handles.length}`);
        console.log(`  Input proof length: ${encrypted.inputProof.length} bytes`);

        return {
            encryptedDecoder: encrypted.handles[0],
            encryptedTarget: encrypted.handles[1],
            encryptedSelector: encrypted.handles[2],
            encryptedArgs: encrypted.handles.slice(3),
            inputProof: ethers.hexlify(encrypted.inputProof)
        };
    } catch (error) {
        console.error("❌ Encryption failed:", error);
        throw error;
    }
}

/**
 * Create and submit a simple USDC transfer UEI
 */
async function createUSDCTransferUEI() {
    try {
        console.log("\n🚀 Creating USDC Transfer UEI\n");
        console.log("=" .repeat(60));

        // Setup provider and wallet
        const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

        console.log("👤 Submitter wallet:", wallet.address);
        console.log("💰 Boring Vault:", BORING_VAULT);
        console.log("🏦 SwapManager:", SWAP_MANAGER);
        console.log("💵 USDC:", USDC_SEPOLIA);

        // Load SwapManager ABI
        const swapManagerAbi = JSON.parse(
            fs.readFileSync('./abis/SwapManager.json', 'utf8')
        );
        const swapManager = new ethers.Contract(SWAP_MANAGER, swapManagerAbi, wallet);

        // Simple USDC transfer parameters
        // transfer(address to, uint256 amount)
        const transferSelector = '0xa9059cbb'; // transfer function selector
        const recipient = wallet.address; // Transfer to deployer for testing
        const amount = ethers.parseUnits('100', 6); // 100 USDC (6 decimals)

        console.log("\n📋 Transfer Details:");
        console.log(`  From: ${BORING_VAULT} (BoringVault)`);
        console.log(`  To: ${recipient}`);
        console.log(`  Amount: ${ethers.formatUnits(amount, 6)} USDC`);
        console.log(`  Selector: ${transferSelector}`);

        // Initialize FHEVM
        await initializeFhevmInstance();

        // Batch encrypt: decoder, target, selector, args
        console.log("\n🔐 Encrypting UEI components...");
        const encrypted = await batchEncryptUEIComponents(
            MOCK_ERC20_DECODER,  // decoder
            USDC_SEPOLIA,        // target (USDC contract)
            transferSelector,    // selector (transfer)
            [
                BigInt(recipient),  // arg[0]: recipient address as uint256
                amount             // arg[1]: amount as uint256
            ],
            SWAP_MANAGER,        // contract address for encryption context
            wallet.address       // signer address
        );

        // Create ctBlob with NEW FORMAT: NO argTypes!
        // Format: abi.encode(bytes32 encDecoder, bytes32 encTarget, bytes32 encSelector, bytes32[] encArgs)
        const ctBlob = ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32', 'bytes32', 'bytes32[]'],
            [
                ethers.hexlify(encrypted.encryptedDecoder),
                ethers.hexlify(encrypted.encryptedTarget),
                ethers.hexlify(encrypted.encryptedSelector),
                encrypted.encryptedArgs.map(handle => ethers.hexlify(handle))
            ]
        );

        console.log("\n📦 Created ctBlob:");
        console.log(`  Size: ${ctBlob.length} bytes`);
        console.log(`  Input proof: ${encrypted.inputProof.length} chars`);

        // Submit to SwapManager
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

        console.log("\n📤 Submitting UEI to SwapManager...");
        console.log(`  Deadline: ${new Date(deadline * 1000).toLocaleString()}`);

        const tx = await swapManager.submitEncryptedUEI(
            ctBlob,
            encrypted.inputProof,
            deadline
        );

        console.log(`  Transaction hash: ${tx.hash}`);
        console.log("  Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log("✅ UEI submitted successfully!");

        // Extract intent ID from TradeSubmitted event
        const tradeSubmittedEvent = receipt.logs.find((log: any) => {
            try {
                const parsed = swapManager.interface.parseLog(log);
                return parsed && parsed.name === 'TradeSubmitted';
            } catch {
                return false;
            }
        });

        if (tradeSubmittedEvent) {
            const parsed = swapManager.interface.parseLog(tradeSubmittedEvent);
            const tradeId = parsed?.args[0];
            const batchId = parsed?.args[2];

            console.log("\n🎯 Trade Details:");
            console.log(`  Trade ID: ${tradeId}`);
            console.log(`  Batch ID: ${batchId}`);
            console.log(`  Submitter: ${parsed?.args[1]}`);
            console.log(`  Deadline: ${new Date(Number(parsed?.args[4]) * 1000).toLocaleString()}`);

            // Check task details
            const task = await swapManager.getUEITask(tradeId);
            console.log("\n📊 Task Status:");
            console.log(`  Status: ${['Pending', 'Processing', 'Executed', 'Failed', 'Expired'][task.status]}`);
            console.log(`  Batch ID: ${task.batchId}`);

            console.log("\n⏳ Next Steps:");
            console.log("  1. Waiting 5 seconds before triggering batch finalization...");
            console.log("  2. Admin will forcefully finalize batch (admin override)");
            console.log("  3. Operator will decrypt and process via ueiProcessor.ts");

            // Wait 5 seconds
            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log("\n🔨 Finalizing batch as admin...");
            const finalizeTx = await swapManager.finalizeUEIBatch();
            console.log(`  Transaction hash: ${finalizeTx.hash}`);
            console.log("  Waiting for confirmation...");

            const finalizeReceipt = await finalizeTx.wait();
            console.log("✅ Batch finalized!");

            // Extract UEIBatchFinalized event
            const batchFinalizedEvent = finalizeReceipt.logs.find((log: any) => {
                try {
                    const parsed = swapManager.interface.parseLog(log);
                    return parsed && parsed.name === 'UEIBatchFinalized';
                } catch {
                    return false;
                }
            });

            if (batchFinalizedEvent) {
                const parsed = swapManager.interface.parseLog(batchFinalizedEvent);
                const finalizedBatchId = parsed?.args[0];
                const selectedOperators = parsed?.args[1];
                const finalizedAt = parsed?.args[2];

                console.log("\n🎉 Batch Finalized Event:");
                console.log(`  Batch ID: ${finalizedBatchId}`);
                console.log(`  Selected Operators (${selectedOperators.length}):`);
                selectedOperators.forEach((op: string, i: number) => {
                    console.log(`    ${i + 1}. ${op}`);
                });
                console.log(`  Finalized at: ${new Date(Number(finalizedAt) * 1000).toLocaleString()}`);
                console.log("\n👂 Operator should now pick up and process this batch!");
            }
        }

        console.log("\n" + "=".repeat(60));

    } catch (error: any) {
        console.error("\n❌ Failed to create UEI:", error);
        if (error.message) console.error("Error message:", error.message);
        throw error;
    }
}

// Run if executed directly
if (require.main === module) {
    createUSDCTransferUEI().catch(console.error);
}

export { createUSDCTransferUEI };
