import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// Contract addresses
const UNIVERSAL_PRIVACY_HOOK = "0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080";
const USDC_ADDRESS = "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1";
const USDT_ADDRESS = "0xB1D9519e953B8513a4754f9B33d37eDba90c001D";

// Hook ABI
const hookAbi = [
    "function deposit(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, address currency, uint256 amount) external",
];

// ERC20 ABI for approvals
const erc20Abi = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address owner) external view returns (uint256)",
];

async function depositBothTokens() {
    console.log("=== Depositing 500 USDC and 500 USDT ===");
    console.log("Wallet address:", wallet.address);

    const hook = new ethers.Contract(UNIVERSAL_PRIVACY_HOOK, hookAbi, wallet);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
    const usdtContract = new ethers.Contract(USDT_ADDRESS, erc20Abi, wallet);

    // Pool key (must match what's used in submitIntent)
    const poolKey = {
        currency0: USDC_ADDRESS,
        currency1: USDT_ADDRESS,
        fee: 3000,
        tickSpacing: 60,
        hooks: UNIVERSAL_PRIVACY_HOOK
    };

    // Check balances
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    const usdtBalance = await usdtContract.balanceOf(wallet.address);
    console.log("USDC balance:", ethers.formatUnits(usdcBalance, 6));
    console.log("USDT balance:", ethers.formatUnits(usdtBalance, 6));

    const depositAmount = ethers.parseUnits("500", 6); // 500 USDC/USDT with 6 decimals

    try {
        // Deposit USDC first
        console.log("\n=== USDC Deposit ===");
        console.log("1. Approving 500 USDC...");
        let tx = await usdcContract.approve(UNIVERSAL_PRIVACY_HOOK, depositAmount);
        console.log("Approval tx:", tx.hash);
        await tx.wait();
        console.log("✅ USDC approved!");

        console.log("2. Depositing 500 USDC...");
        tx = await hook.deposit(poolKey, USDC_ADDRESS, depositAmount);
        console.log("Deposit tx:", tx.hash);
        let receipt = await tx.wait();
        console.log("✅ USDC deposited! Gas used:", receipt.gasUsed.toString());

        // Deposit USDT
        console.log("\n=== USDT Deposit ===");
        console.log("3. Approving 500 USDT...");
        tx = await usdtContract.approve(UNIVERSAL_PRIVACY_HOOK, depositAmount);
        console.log("Approval tx:", tx.hash);
        await tx.wait();
        console.log("✅ USDT approved!");

        console.log("4. Depositing 500 USDT...");
        tx = await hook.deposit(poolKey, USDT_ADDRESS, depositAmount);
        console.log("Deposit tx:", tx.hash);
        receipt = await tx.wait();
        console.log("✅ USDT deposited! Gas used:", receipt.gasUsed.toString());

        console.log("\n=== Deposits Complete ===");
            console.log("✅ Deposited 500 USDC");
        console.log("✅ Deposited 500 USDT");
        console.log("\nUser now has encrypted tokens for both USDC and USDT!");
        console.log("The encrypted USDT token should now be created for the pool.");

    } catch (error: any) {
        console.error("Error during deposit:", error);
        if (error.data) {
            console.error("Error data:", error.data);
        }
    }
}

depositBothTokens().catch(console.error);