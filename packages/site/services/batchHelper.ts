import { ethers } from 'ethers';
import { CONTRACTS, getPoolKey } from '../config/contracts';
import { UniversalPrivacyHookABI } from '../abi/UniversalPrivacyHookABI';

/**
 * Helper service to auto-submit counter-intents after user swaps
 * This ensures batches get finalized quickly (within 5 blocks)
 */

// IMPORTANT: This helper wallet private key should be stored securely
// For production, use environment variables or a secure key management service
// The helper wallet needs to have deposited tokens in the pool
const HELPER_WALLET_PRIVATE_KEY = process.env.NEXT_PUBLIC_HELPER_WALLET_KEY || '';

// Public RPC for the helper (no user wallet needed)
const provider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');

interface IntentParams {
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
}

/**
 * Submits a counter-intent from the helper wallet
 * If user swaps USDC→USDT, this swaps USDT→USDC
 * Always uses fixed 1 token amount (500 helper deposits = 500 transactions)
 */
export async function submitCounterIntent(
  userIntent: IntentParams,
  fhevmInstance: any
): Promise<void> {
  if (!HELPER_WALLET_PRIVATE_KEY) {
    console.log('Helper wallet not configured, skipping auto-submit');
    return;
  }

  try {
    const helperWallet = new ethers.Wallet(HELPER_WALLET_PRIVATE_KEY, provider);
    const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, helperWallet);
    const poolKey = getPoolKey();

    // Create counter-intent (swap opposite direction)
    const counterTokenIn = userIntent.tokenOut;
    const counterTokenOut = userIntent.tokenIn;

    // Always use fixed 1 token amount (1 * 10^6 for 6 decimals)
    const counterAmount = BigInt(1 * 1e6);

    console.log(`Submitting counter-intent: 1 token from helper wallet (opposite direction)`);

    // Encrypt the counter-intent amount
    const input = fhevmInstance.createEncryptedInput(
      CONTRACTS.UniversalPrivacyHook,
      helperWallet.address
    );

    input.add128(counterAmount);
    const encrypted = await input.encrypt();

    // Submit counter-intent
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const feeData = await provider.getFeeData();
    const gasPrice = (feeData.gasPrice! * 120n) / 100n;

    const tx = await hook.submitIntent(
      poolKey,
      counterTokenIn,
      counterTokenOut,
      encrypted.handles[0],
      encrypted.inputProof,
      deadline,
      {
        gasLimit: 1000000,
        gasPrice: gasPrice
      }
    );

    console.log(`Counter-intent submitted: ${tx.hash}`);
    await tx.wait();
    console.log('Counter-intent confirmed');

    // Schedule a finalization trigger after 5 blocks (~60 seconds)
    setTimeout(() => {
      submitFinalizationTrigger(fhevmInstance, helperWallet).catch(console.error);
    }, 60000); // Wait 60 seconds (~5 blocks)

  } catch (error) {
    console.error('Error submitting counter-intent:', error);
  }
}

/**
 * Submits a small intent to trigger batch finalization
 * This runs 5 blocks after the initial counter-intent
 */
async function submitFinalizationTrigger(
  fhevmInstance: any,
  helperWallet: ethers.Wallet
): Promise<void> {
  try {
    const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, helperWallet);
    const poolKey = getPoolKey();

    console.log('Submitting finalization trigger intent...');

    // Submit a small intent (1 unit) to trigger batch finalization
    const smallAmount = BigInt(1);

    const input = fhevmInstance.createEncryptedInput(
      CONTRACTS.UniversalPrivacyHook,
      helperWallet.address
    );

    input.add128(smallAmount);
    const encrypted = await input.encrypt();

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const feeData = await provider.getFeeData();
    const gasPrice = (feeData.gasPrice! * 120n) / 100n;

    const tx = await hook.submitIntent(
      poolKey,
      CONTRACTS.MockUSDC, // Doesn't matter, just to trigger finalization
      CONTRACTS.MockUSDT,
      encrypted.handles[0],
      encrypted.inputProof,
      deadline,
      {
        gasLimit: 1000000,
        gasPrice: gasPrice
      }
    );

    console.log(`Finalization trigger submitted: ${tx.hash}`);
    await tx.wait();
    console.log('Batch should finalize now!');

  } catch (error) {
    console.error('Error submitting finalization trigger:', error);
  }
}

/**
 * Check if helper wallet has sufficient deposits
 */
export async function checkHelperWalletBalance(): Promise<{
  hasBalance: boolean;
  eUSDC: string;
  eUSDT: string;
}> {
  if (!HELPER_WALLET_PRIVATE_KEY) {
    return { hasBalance: false, eUSDC: '0', eUSDT: '0' };
  }

  try {
    const helperWallet = new ethers.Wallet(HELPER_WALLET_PRIVATE_KEY, provider);

    // Check encrypted token balances
    const eUsdcContract = new ethers.Contract(
      CONTRACTS.EncryptedUSDC,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const eUsdtContract = new ethers.Contract(
      CONTRACTS.EncryptedUSDT,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const eUsdcBalance = await eUsdcContract.balanceOf(helperWallet.address);
    const eUsdtBalance = await eUsdtContract.balanceOf(helperWallet.address);

    return {
      hasBalance: eUsdcBalance > BigInt(0) && eUsdtBalance > BigInt(0),
      eUSDC: ethers.formatUnits(eUsdcBalance, 6),
      eUSDT: ethers.formatUnits(eUsdtBalance, 6)
    };
  } catch (error) {
    console.error('Error checking helper wallet balance:', error);
    return { hasBalance: false, eUSDC: '0', eUSDT: '0' };
  }
}