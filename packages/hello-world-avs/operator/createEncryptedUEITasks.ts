/**
 * Create Encrypted UEI Tasks - Simplified for Testing
 *
 * This script submits a simple USDC transfer UEI to the SwapManager
 * Flow:
 * 1. Encrypt: decoder (address), target (USDC), selector (transfer), args [recipient, amount]
 * 2. Submit to SwapManager.submitEncryptedUEIBatch(ctBlobs, inputProofs, deadlines)
 * 3. Wait for batch finalization (handled by keeper or manual call)
 * 4. Operator will decrypt and process (handled by ueiProcessor.ts)
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import { CHAIN_DEPLOYMENTS, CHAIN_IDS, ChainIdLiteral } from './config/chains';
import { PROTOCOL_FUNCTIONS } from './utils';

dotenv.config();

const PROVIDER_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_KEY';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const DEFAULT_SWAP_MANAGER = '0x892c61920D2c8B8C94482b75e7044484dBFd75d4';
const DEFAULT_BORING_VAULT = '0x1B7Bbc206Fc58413dCcDC9A4Ad1c5a95995a3926';
const DEFAULT_USDC = '0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1'; // Sepolia USDC fallback

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
    chainId: number,
    args: (string | bigint)[],
    contractAddress: string,
    signerAddress: string
): Promise<{
    encryptedDecoder: any;
    encryptedTarget: any;
    encryptedSelector: any;
    encryptedChainId: any;
    encryptedArgs: any[];
    inputProof: string;
}> {
    try {
        console.log("🔐 Batch encrypting UEI components...");
        console.log(`  Decoder: ${decoder}`);
        console.log(`  Target: ${target}`);
        console.log(`  Selector: ${selector}`);
        console.log(`  ChainId: ${chainId}`);
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

        // Encrypt chainId as euint32
        encryptedInput.add32(chainId);

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
            encryptedChainId: encrypted.handles[3],
            encryptedArgs: encrypted.handles.slice(4),
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
        console.log("\n🚀 Creating Sample UEIs\n");
        console.log("=".repeat(60));

        // Setup provider and wallet
        const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const network = await provider.getNetwork();
        const chainId = Number(network.chainId);

        const chainDeployment = CHAIN_DEPLOYMENTS[
            chainId as ChainIdLiteral
        ];
        if (!chainDeployment) {
            throw new Error(`No chain deployment metadata found for chainId ${chainId}`);
        }

        const swapManagerAddress = chainDeployment.swapManager ?? DEFAULT_SWAP_MANAGER;
        const boringVaultAddress = chainDeployment.boringVault ?? DEFAULT_BORING_VAULT;
        const usdcAddress = chainDeployment.tokens?.USDC ?? DEFAULT_USDC;
        const ptEusdeAddress = chainDeployment.tokens?.PT_eUSDE;
        const aaveAddress = chainDeployment.protocols?.aave;
        if (!ptEusdeAddress || !aaveAddress) {
            throw new Error("PT-eUSDE or Aave address missing in deployment metadata");
        }
        const aaveSupplyFn = PROTOCOL_FUNCTIONS.find(
            (fn) => fn.protocol === "aave" && fn.functionName === "supply"
        );
        if (!aaveSupplyFn) {
            throw new Error("Unable to locate Aave supply metadata");
        }
        const aaveSupplySelector = aaveSupplyFn.selector;

        console.log("👤 Submitter wallet:", wallet.address);
        console.log("💰 Boring Vault:", boringVaultAddress);
        console.log("🏦 SwapManager:", swapManagerAddress);
        console.log("💵 USDC:", usdcAddress);
        console.log("📦 PT-eUSDE:", ptEusdeAddress);
        console.log("🏦 Aave Pool:", aaveAddress);
        console.log("🌐 ChainId:", chainId);

        // Load SwapManager ABI
        const swapManagerAbi = JSON.parse(
            fs.readFileSync('./abis/SwapManager.json', 'utf8')
        );
        const swapManager = new ethers.Contract(swapManagerAddress, swapManagerAbi, wallet);

        // Simple USDC transfer parameters
        // transfer(address to, uint256 amount)
        const transferSelector = '0xa9059cbb'; // transfer function selector
        const recipient = wallet.address; // Transfer to deployer for testing
        const amount = ethers.parseUnits('100', 6); // 100 tokens (6 decimals)

        console.log("\n📋 Transfer Details:");
        console.log(`  From: ${boringVaultAddress} (BoringVault)`);
        console.log(`  To: ${recipient}`);
        console.log(`  Amount: ${ethers.formatUnits(amount, 6)} USDC`);
        console.log(`  Selector: ${transferSelector}`);

        // Initialize FHEVM
        await initializeFhevmInstance();

        const intentTemplates = [
            {
                description: "Transfer 100 USDC back to the submitter",
                decoder: MOCK_ERC20_DECODER,
                target: usdcAddress,
                selector: transferSelector,
                args: [
                    BigInt(recipient),
                    amount
                ]
            },
            {
                description: "Supply 100 PT-eUSDE to Aave on behalf of the boring vault",
                decoder: MOCK_ERC20_DECODER,
                target: aaveAddress,
                selector: aaveSupplySelector,
                args: [
                    BigInt(ptEusdeAddress),
                    amount,
                    BigInt(boringVaultAddress),
                    0n
                ]
            }
        ];

        const ctBlobs: string[] = [];
        const inputProofs: string[] = [];
        const deadlines: bigint[] = [];

        const deadlineBase = Math.floor(Date.now() / 1000);

        console.log("\n🔐 Encrypting UEI components...");
        for (let i = 0; i < intentTemplates.length; i++) {
            const template = intentTemplates[i];
            console.log(`\nIntent ${i + 1}: ${template.description}`);

            const encrypted = await batchEncryptUEIComponents(
                template.decoder,
                template.target,
                template.selector,
                i === 0 ? CHAIN_IDS.ETHEREUM_SEPOLIA : CHAIN_IDS.BASE_SEPOLIA,
                template.args,
                swapManagerAddress,
                wallet.address
            );

            const ctBlob = ethers.AbiCoder.defaultAbiCoder().encode(
                ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32[]'],
                [
                    ethers.hexlify(encrypted.encryptedDecoder),
                    ethers.hexlify(encrypted.encryptedTarget),
                    ethers.hexlify(encrypted.encryptedSelector),
                    ethers.hexlify(encrypted.encryptedChainId),
                    encrypted.encryptedArgs.map(handle => ethers.hexlify(handle))
                ]
            );

            console.log("📦 Created ctBlob");
            console.log(`  Size: ${ctBlob.length} bytes`);
            console.log(`  Input proof: ${encrypted.inputProof.length} chars`);

            ctBlobs.push(ctBlob);
            inputProofs.push(encrypted.inputProof);
            deadlines.push(BigInt(deadlineBase + 3600 + (i * 300))); // stagger deadlines slightly
        }

        console.log("\n📤 Submitting batched UEIs to SwapManager...");
        const expectedIds: string[] = await swapManager.submitEncryptedUEIBatch.staticCall(
            ctBlobs,
            inputProofs,
            deadlines
        );
        const tx = await swapManager.submitEncryptedUEIBatch(
            ctBlobs,
            inputProofs,
            deadlines
        );

        console.log(`  Transaction hash: ${tx.hash}`);
        console.log("  Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log("✅ UEIs submitted successfully!");

        console.log("\n🎯 Returned intent IDs (callStatic):");
        expectedIds.forEach((id: string, index: number) => {
            console.log(`  ${index + 1}. ${id}`);
        });

        const tradeEvents = receipt.logs
            .map((log: any) => {
                try {
                    const parsed = swapManager.interface.parseLog(log);
                    return parsed && parsed.name === 'TradeSubmitted' ? parsed : null;
                } catch {
                    return null;
                }
            })
            .filter((evt: any) => evt !== null);

        if (tradeEvents.length > 0) {
            console.log("\n🎯 Trade Details:");
            tradeEvents.forEach((event: any, index: number) => {
                const tradeId = event.args[0];
                const submitter = event.args[1];
                const batchId = event.args[2];
                const deadline = event.args[4];

                console.log(`\nTrade ${index + 1}`);
                console.log(`  Trade ID: ${tradeId}`);
                console.log(`  Batch ID: ${batchId}`);
                console.log(`  Submitter: ${submitter}`);
                console.log(`  Deadline: ${new Date(Number(deadline) * 1000).toLocaleString()}`);

                deadlines[index] = BigInt(deadline);
            });
        }

        if (tradeEvents.length) {
            const batchId = tradeEvents[0].args[2];
            const task = await swapManager.getTradeBatch(batchId);
            console.log("\n📊 Batch Snapshot (pre-finalize):");
            console.log(`  Intent IDs tracked: ${task.intentIds.length}`);
        }

        console.log("\n⏳ Next Steps:");
        console.log("  1. Waiting 5 seconds before triggering batch finalization...");
        console.log("  2. Admin will finalize the batch (demo override).");
        console.log("  3. Operators can then process all intents via ueiProcessor.ts.");

        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log("\n🔨 Finalizing batch as admin...");
        const finalizeTx = await swapManager.finalizeUEIBatch();
        console.log(`  Transaction hash: ${finalizeTx.hash}`);
        console.log("  Waiting for confirmation...");

        const finalizeReceipt = await finalizeTx.wait();
        console.log("✅ Batch finalized!");

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
