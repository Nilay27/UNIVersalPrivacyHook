import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// Encrypted token addresses
const USDC_ENCRYPTED = "0x7ca54AE6861ABb2071b5186622Daf906BC4Bd854";
const USDT_ENCRYPTED = "0x2E31EFe0BE307E3126b29C0E979121F617134093";

// ABI for HybridFHERC20
const encTokenAbi = [
    "function encBalances(address) external view returns (bytes32)",
    "function decimals() external view returns (uint8)",
    "function name() external view returns (string)",
    "function symbol() external view returns (string)"
];

async function checkEncryptedBalances() {
    console.log("=== Checking Encrypted Token Balances ===\n");
    console.log("Wallet address:", wallet.address);

    // Initialize FHEVM instance
    console.log("Initializing FHEVM instance...");
    const fhevmInstance = await createInstance({
        ...SepoliaConfig,
        network: process.env.RPC_URL!
    });

    // Generate keypair for decryption
    const keypair = fhevmInstance.generateKeypair();
    console.log("Generated keypair for decryption\n");

    // Check USDC encrypted token
    console.log("=== USDC Encrypted Token ===");
    console.log("Token address:", USDC_ENCRYPTED);

    const usdcEncToken = new ethers.Contract(USDC_ENCRYPTED, encTokenAbi, wallet);

    // Get token info
    const usdcName = await usdcEncToken.name();
    const usdcSymbol = await usdcEncToken.symbol();
    const usdcDecimals = await usdcEncToken.decimals();
    console.log(`Token: ${usdcName} (${usdcSymbol})`);
    console.log(`Decimals: ${usdcDecimals}`);

    // Get encrypted balance handle for user
    const userUsdcHandle = await usdcEncToken.encBalances(wallet.address);
    console.log("User's encrypted balance handle:", userUsdcHandle);

    // Decrypt USDC balance
    if (userUsdcHandle !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        try {
            console.log("Decrypting USDC balance...");

            // Create EIP712 signature using the same method as ueiProcessor
            const contractAddresses = [USDC_ENCRYPTED];
            const startTimestamp = Math.floor(Date.now() / 1000);
            const durationDays = 7;

            const eip712 = fhevmInstance.createEIP712(
                keypair.publicKey,
                contractAddresses,
                startTimestamp,
                durationDays
            );

            const typesWithoutDomain = { ...eip712.types };
            delete typesWithoutDomain.EIP712Domain;

            // Sign with wallet
            const signature = await wallet.signTypedData(
                eip712.domain,
                typesWithoutDomain,
                eip712.message
            );

            // Prepare parameters for userDecrypt
            const handleContractPairs = [{
                handle: userUsdcHandle,
                contractAddress: USDC_ENCRYPTED
            }];

            const result = await fhevmInstance.userDecrypt(
                handleContractPairs,
                keypair.privateKey,
                keypair.publicKey,
                signature,
                contractAddresses,
                wallet.address,
                startTimestamp,
                durationDays
            );
            // Result is an object with handle as key
            const decryptedBalance = result[userUsdcHandle];
            console.log("Decrypted USDC balance:", ethers.formatUnits(BigInt(decryptedBalance.toString()), usdcDecimals), "eUSDC");
        } catch (error: any) {
            console.error("Error decrypting USDC balance:", error.message);
        }
    }

    // Check USDT encrypted token
    console.log("\n=== USDT Encrypted Token ===");
    console.log("Token address:", USDT_ENCRYPTED);

    const usdtEncToken = new ethers.Contract(USDT_ENCRYPTED, encTokenAbi, wallet);

    // Get token info
    const usdtName = await usdtEncToken.name();
    const usdtSymbol = await usdtEncToken.symbol();
    const usdtDecimals = await usdtEncToken.decimals();
    console.log(`Token: ${usdtName} (${usdtSymbol})`);
    console.log(`Decimals: ${usdtDecimals}`);

    // Get encrypted balance handle for user
    const userUsdtHandle = await usdtEncToken.encBalances(wallet.address);
    console.log("User's encrypted balance handle:", userUsdtHandle);

    // Decrypt USDT balance
    if (userUsdtHandle !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        try {
            console.log("Decrypting USDT balance...");

            // Create EIP712 signature using the same method as ueiProcessor
            const contractAddresses = [USDT_ENCRYPTED];
            const startTimestamp = Math.floor(Date.now() / 1000);
            const durationDays = 7;

            const eip712 = fhevmInstance.createEIP712(
                keypair.publicKey,
                contractAddresses,
                startTimestamp,
                durationDays
            );

            const typesWithoutDomain = { ...eip712.types };
            delete typesWithoutDomain.EIP712Domain;

            // Sign with wallet
            const signature = await wallet.signTypedData(
                eip712.domain,
                typesWithoutDomain,
                eip712.message
            );

            // Prepare parameters for userDecrypt
            const handleContractPairs = [{
                handle: userUsdtHandle,
                contractAddress: USDT_ENCRYPTED
            }];

            const result = await fhevmInstance.userDecrypt(
                handleContractPairs,
                keypair.privateKey,
                keypair.publicKey,
                signature,
                contractAddresses,
                wallet.address,
                startTimestamp,
                durationDays
            );

            // Result is an object with handle as key
            const decryptedBalance = result[userUsdtHandle];
            console.log("Decrypted USDT balance:", ethers.formatUnits(BigInt(decryptedBalance.toString()), usdtDecimals), "eUSDT");
        } catch (error: any) {
            console.error("Error decrypting USDT balance:", error.message);
        }
    }

    console.log("\n=== Summary ===");
    console.log("Successfully decrypted encrypted token balances!");
}

checkEncryptedBalances().catch(console.error);