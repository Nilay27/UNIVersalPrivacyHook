import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { initializeFhevm, encryptAmount } from './fhevmUtils';

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

    // Encrypt each component
    console.log("\n🔐 Encrypting UEI components...");

        // Encrypt decoder address
        const ctDecoder = await encryptUEIComponent(strategy.decoder);
        console.log("  ✅ Encrypted decoder:", ctDecoder.toString());

        // Encrypt target address
        const ctTarget = await encryptUEIComponent(strategy.target);
        console.log("  ✅ Encrypted target:", ctTarget.toString());

        // Encrypt selector
        const ctSelector = await encryptUEIComponent(strategy.selector);
        console.log("  ✅ Encrypted selector:", ctSelector.toString());

        // Encrypt arguments
        console.log("\n🔐 Encrypting arguments...");
        const ctArgs: bigint[] = [];
        for (let i = 0; i < strategy.args.length; i++) {
            let arg = strategy.args[i];

            // Replace null with boringVault address
            if (arg === null) {
                arg = boringVaultAddress;
            }

            // Ensure arg is not null before encryption
            if (arg === null || arg === undefined) {
                throw new Error(`Argument at index ${i} is null or undefined`);
            }

            const encryptedArg = await encryptUEIComponent(arg as string | number);
            ctArgs.push(encryptedArg);
            console.log(`  ✅ Encrypted arg[${i}]:`, encryptedArg.toString());
        }

        // Create the blob
        const ctBlob = ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256', 'uint256', 'uint256', 'uint8[]', 'uint256[]'],
            [
                ctDecoder.toString(),
                ctTarget.toString(),
                ctSelector.toString(),
                strategy.argTypes,
                ctArgs.map(a => a.toString())
            ]
        );

        console.log("\n📦 Created encrypted blob, length:", ctBlob.length);

        // Submit UEI through MockPrivacyHook
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

        console.log("\n📤 Submitting UEI to MockPrivacyHook...");
        console.log("  Blob size:", ctBlob.length, "bytes");
        console.log("  Deadline:", deadline);

        // Get current nonce to avoid nonce issues
        const nonce = await wallet.getNonce();
        console.log("  Using nonce:", nonce);

        const tx = await mockHook.submitUEIBlob(ctBlob, deadline, { nonce });
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

    // Create UEIs periodically
    const createUEI = async () => {
        await createEncryptedUEI(provider, wallet);
    };

    // Create first UEI immediately
    await createUEI();

    // Then create one every 30 seconds
    setInterval(createUEI, 30000);

    console.log("\n⏰ Will create new UEIs every 30 seconds...");
    console.log("Press Ctrl+C to stop\n");
}

main().catch(console.error);