import { useCallback, useState } from 'react';
import { useMetaMaskEthersSigner } from './metamask/useMetaMaskEthersSigner';
import { ethers } from 'ethers';
import { UniversalPrivacyHookABI } from '../abi/UniversalPrivacyHookABI';
import { MockERC20ABI } from '../abi/MockERC20ABI';
import { HybridFHERC20ABI } from '../abi/HybridFHERC20ABI';
import { CONTRACTS, getPoolKey } from '../config/contracts';

export const useUniversalPrivacyHook = () => {
  const { ethersSigner: signer, ethersBrowserProvider: provider } = useMetaMaskEthersSigner();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deposit = useCallback(async (currency: 'USDC' | 'USDT', amount: string) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get the pool key
      const poolKey = getPoolKey();
      
      // Get currency address
      const currencyAddress = currency === 'USDC' ? CONTRACTS.MockUSDC : CONTRACTS.MockUSDT;
      
      // Parse amount (assuming 6 decimals for both USDC and USDT)
      const parsedAmount = ethers.parseUnits(amount, 6);
      
      // Create contract instances
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, signer);
      const token = new ethers.Contract(currencyAddress, MockERC20ABI.abi, signer);
      
      // Check allowance
      const allowance = await token.allowance(await signer.getAddress(), CONTRACTS.UniversalPrivacyHook);
      
      // Approve if needed (with 2x the amount for safety)
      const approvalAmount = parsedAmount * BigInt(2);
      if (allowance < approvalAmount) {
        console.log('Approving token spend...');
        const approveTx = await token.approve(CONTRACTS.UniversalPrivacyHook, approvalAmount);
        await approveTx.wait();
        console.log('Approval confirmed for', ethers.formatUnits(approvalAmount, 6));
      }
      
      // Deposit with gas buffer
      console.log('Depositing tokens...');
      const estimatedGas = await hook.deposit.estimateGas(poolKey, currencyAddress, parsedAmount);
      const gasLimit = estimatedGas * BigInt(120) / BigInt(100);
      
      const depositTx = await hook.deposit(poolKey, currencyAddress, parsedAmount, { gasLimit });
      await depositTx.wait();
      console.log('Deposit confirmed');
      
      return depositTx.hash;
    } catch (err: any) {
      console.error('Deposit error:', err);
      setError(err.message || 'Deposit failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [signer]);

  const submitIntent = useCallback(async (
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    encryptedAmount: string,
    inputProof: string,
    deadline?: number
  ) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const poolKey = getPoolKey();
      const tokenInAddress = tokenIn === 'USDC' ? CONTRACTS.MockUSDC : CONTRACTS.MockUSDT;
      const tokenOutAddress = tokenOut === 'USDC' ? CONTRACTS.MockUSDC : CONTRACTS.MockUSDT;
      
      // Default deadline to 1 hour from now
      const finalDeadline = deadline || Math.floor(Date.now() / 1000) + 3600;
      
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, signer);
      
      console.log('Submitting intent with params:', {
        poolKey,
        tokenInAddress,
        tokenOutAddress,
        encryptedAmount,
        inputProof,
        finalDeadline
      });
      
      // Try to estimate gas first
      let gasLimit;
      try {
        const estimatedGas = await hook.submitIntent.estimateGas(
          poolKey,
          tokenInAddress,
          tokenOutAddress,
          encryptedAmount,
          inputProof,
          finalDeadline
        );
        gasLimit = estimatedGas * BigInt(120) / BigInt(100); // Add 20% buffer
        console.log('Estimated gas:', estimatedGas.toString(), 'Using gas limit:', gasLimit.toString());
      } catch (estimateError: any) {
        console.error('Gas estimation failed:', estimateError);
        console.error('Error details:', {
          message: estimateError.message,
          data: estimateError.data,
          reason: estimateError.reason
        });
        // Use a higher fallback gas limit if estimation fails
        gasLimit = BigInt(1000000);
        console.log('Using fallback gas limit:', gasLimit.toString());
        
        // If the error is about execution reverting, throw it to show the user
        if (estimateError.message?.includes('execution reverted')) {
          throw new Error('Transaction would fail on-chain. Please check your balances and try again.');
        }
      }
      
      const tx = await hook.submitIntent(
        poolKey,
        tokenInAddress,
        tokenOutAddress,
        encryptedAmount,
        inputProof,
        finalDeadline,
        { gasLimit }
      );
      
      const receipt = await tx.wait();
      console.log('Intent submitted');
      
      // Extract intent ID from events
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = hook.interface.parseLog(log);
          return parsed?.name === 'IntentSubmitted';
        } catch {
          return false;
        }
      });
      
      const intentId = event ? hook.interface.parseLog(event)?.args?.intentId : null;
      
      return { txHash: tx.hash, intentId };
    } catch (err: any) {
      console.error('Submit intent error:', err);
      setError(err.message || 'Submit intent failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [signer]);

  const getEncryptedBalance = useCallback(async (currency: 'USDC' | 'USDT', address?: string) => {
    if (!provider) return null;
    
    try {
      const encryptedTokenAddress = currency === 'USDC' 
        ? CONTRACTS.EncryptedUSDC 
        : CONTRACTS.EncryptedUSDT;
      
      let targetAddress = address;
      if (!targetAddress && signer) {
        targetAddress = await signer.getAddress();
      }
      if (!targetAddress) return null;
      
      const encToken = new ethers.Contract(encryptedTokenAddress, HybridFHERC20ABI.abi, provider);
      // Use encBalances for encrypted balance - returns the handle (euint128)
      const encBalance = await encToken.encBalances(targetAddress);
      
      // Return the raw encrypted handle value (not formatted)
      return encBalance.toString();
    } catch (err) {
      console.error('Error getting encrypted balance:', err);
      return null;
    }
  }, [provider, signer]);

  const getRegularBalance = useCallback(async (currency: 'USDC' | 'USDT', address?: string) => {
    if (!provider) return null;
    
    try {
      const tokenAddress = currency === 'USDC' 
        ? CONTRACTS.MockUSDC 
        : CONTRACTS.MockUSDT;
      
      let targetAddress = address;
      if (!targetAddress && signer) {
        targetAddress = await signer.getAddress();
      }
      if (!targetAddress) return null;
      
      const token = new ethers.Contract(tokenAddress, MockERC20ABI.abi, provider);
      const balance = await token.balanceOf(targetAddress);
      
      return ethers.formatUnits(balance, 6);
    } catch (err) {
      console.error('Error getting regular balance:', err);
      return null;
    }
  }, [provider, signer]);

  const listenForIntentDecrypted = useCallback((callback: (intentId: string, amount: string) => void) => {
    if (!provider) return;
    
    const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, provider);
    
    const filter = hook.filters.IntentDecrypted();
    
    const listener = (intentId: string, decryptedAmount: bigint) => {
      callback(intentId, ethers.formatUnits(decryptedAmount, 6));
    };
    
    hook.on(filter, listener);
    
    // Return cleanup function
    return () => {
      hook.off(filter, listener);
    };
  }, [provider]);
  
  const checkIntentStatus = useCallback(async (intentId: string) => {
    if (!provider) return null;
    
    try {
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, provider);
      
      // Get intent details from contract
      const intent = await hook.intents(intentId);
      
      // Check if intent is decrypted (decryptedAmount > 0)
      if (intent && intent.decryptedAmount && intent.decryptedAmount > BigInt(0)) {
        return {
          isDecrypted: intent.decrypted === true || intent[6] === true,
          amount: ethers.formatUnits(intent.decryptedAmount, 6),
          isExecuted: intent.processed === true || intent[5] === true
        };
      }
      
      return {
        isDecrypted: false,
        amount: null,
        isExecuted: false
      };
    } catch (err) {
      console.error('Error checking intent status:', err);
      return null;
    }
  }, [provider]);
  
  const fetchUserIntents = useCallback(async (userAddress?: string) => {
    try {
      let targetAddress = userAddress;
      if (!targetAddress && signer) {
        targetAddress = await signer.getAddress();
      }
      if (!targetAddress) return [];
      
      // Use Ankr public RPC for reliable data fetching
      const ankrProvider = new ethers.JsonRpcProvider('https://1rpc.io/sepolia');
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, ankrProvider);
      
      // Calculate block range for last 1 hour (approximately 300 blocks on Sepolia)
      const currentBlock = await ankrProvider.getBlockNumber();
      const oneHourAgo = currentBlock - 300; // ~12 seconds per block
      
      console.log(`Fetching intents from block ${oneHourAgo} to ${currentBlock} for ${targetAddress}`);
      
      // Get IntentSubmitted events for this user in the last 1 hour
      // Event signature: IntentSubmitted(bytes32 indexed poolId, address tokenIn, address tokenOut, address indexed user, bytes32 intentId)
      // We can only filter by indexed parameters (poolId and user)
      const filter = hook.filters.IntentSubmitted(null, null, null, targetAddress, null);
      const events = await hook.queryFilter(filter, oneHourAgo, currentBlock);
      
      console.log(`Found ${events.length} IntentSubmitted events`);
      
      // Map events to intent details
      const intents = await Promise.all(events.map(async (event) => {
        // Parse the event to get all arguments
        const parsedEvent = hook.interface.parseLog({
          topics: event.topics as string[],
          data: event.data
        });
        
        const intentId = parsedEvent?.args?.intentId;
        if (!intentId) {
          console.warn('Could not parse intent ID from event');
          return null;
        }
        
        const intent = await hook.intents(intentId);
        
        // Log the full intent structure to debug
        console.log(`Intent ${intentId} raw data:`, intent);
        
        // Check if the intent has been processed (executed)
        // Based on the contract struct, the field is called 'processed', not 'executed'
        const isProcessed = intent.processed === true || intent[5] === true; // processed is at index 5 in the struct
        
        console.log(`Intent ${intentId}:`, {
          processed: isProcessed,
          decrypted: intent.decrypted || intent[6],
          decryptedAmount: intent.decryptedAmount?.toString() || '0',
          deadline: intent.deadline?.toString()
        });
        
        // Skip this intent if it's been processed (executed)
        if (isProcessed) {
          console.log(`Skipping processed intent ${intentId}`);
          return null;
        }
        
        return {
          id: intentId,
          user: targetAddress!,
          tokenIn: parsedEvent?.args?.tokenIn || intent.tokenIn,
          tokenOut: parsedEvent?.args?.tokenOut || intent.tokenOut,
          deadline: Number(intent.deadline),
          decryptedAmount: intent.decryptedAmount > BigInt(0) ? ethers.formatUnits(intent.decryptedAmount, 6) : null,
          executed: false, // We already filtered out executed ones
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          timestamp: (await ankrProvider.getBlock(event.blockNumber))?.timestamp || 0
        };
      }));
      
      // Filter out null values (executed intents are already filtered), then sort by block number (newest first)
      return intents
        .filter((intent): intent is NonNullable<typeof intent> => intent !== null)
        .sort((a, b) => b.blockNumber - a.blockNumber);
    } catch (err) {
      console.error('Error fetching user intents:', err);
      return [];
    }
  }, [signer]);

  const executeIntent = useCallback(async (intentId: string) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, signer);
      
      console.log('Executing intent...');
      
      // Estimate gas and add 20% buffer
      const estimatedGas = await hook.executeIntent.estimateGas(intentId);
      const gasLimit = estimatedGas * BigInt(120) / BigInt(100);
      
      const tx = await hook.executeIntent(intentId, { gasLimit });
      await tx.wait();
      console.log('Intent executed');
      
      return tx.hash;
    } catch (err: any) {
      console.error('Execute intent error:', err);
      setError(err.message || 'Execute intent failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [signer]);

  const decryptBalance = useCallback(async (
    encryptedHandle: string,
    tokenAddress: string,
    fhevmInstance: any,
    fhevmDecryptionSignatureStorage: any
  ) => {
    if (!signer || !provider || !fhevmInstance) return null;

    try {
      // Follow the exact documentation approach for v0.2.0
      console.log('Starting decryption for handle:', encryptedHandle);

      // Generate a keypair for this decryption
      const keypair = fhevmInstance.generateKeypair();
      console.log('Generated keypair');

      // The handle from the contract is already in the correct format
      // It's a euint128 handle represented as bytes32
      let ciphertextHandle = encryptedHandle;

      // Ensure it has 0x prefix and is lowercase
      if (!ciphertextHandle.startsWith('0x')) {
        ciphertextHandle = '0x' + ciphertextHandle;
      }

      // Convert to lowercase for consistency
      ciphertextHandle = ciphertextHandle.toLowerCase();

      console.log('Formatted handle:', ciphertextHandle);
      console.log('Handle length:', ciphertextHandle.length, '(should be 66 for 0x + 64 hex chars)');
      console.log('Token address:', tokenAddress);

      // Ensure contract address is checksummed
      const checksummedAddress = ethers.getAddress(tokenAddress);

      // Prepare handle-contract pairs
      const handleContractPairs = [
        {
          handle: ciphertextHandle,
          contractAddress: checksummedAddress,
        },
      ];

      // Set timestamps - ensure we're using seconds, not milliseconds
      const now = Date.now();
      const startTimeStamp = Math.floor(now / 1000);
      const durationDays = 10;

      // Debug: Check if timestamp is reasonable
      const dateCheck = new Date(startTimeStamp * 1000);
      console.log('Current date/time:', dateCheck.toISOString());
      console.log('Current timestamp (seconds):', startTimeStamp, 'Duration days:', durationDays);

      // Convert to strings for the API
      const startTimeStampStr = startTimeStamp.toString();
      const durationDaysStr = durationDays.toString();
      const contractAddresses = [checksummedAddress];

      console.log('Creating EIP712 message...');
      // Create EIP712 message with string parameters
      const eip712 = fhevmInstance.createEIP712(
        keypair.publicKey,
        contractAddresses,
        startTimeStampStr,
        durationDaysStr
      );

      console.log('Signing typed data...');
      // Sign the typed data
      const signature = await signer.signTypedData(
        eip712.domain,
        {
          UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification,
        },
        eip712.message,
      );

      const userAddress = await signer.getAddress();
      const cleanSignature = signature.replace("0x", "");

      console.log('Calling userDecrypt with params:', {
        handleContractPairs,
        publicKey: keypair.publicKey.substring(0, 20) + '...',
        signature: cleanSignature.substring(0, 20) + '...',
        contractAddresses,
        userAddress,
        startTimeStamp: startTimeStampStr,
        durationDays: durationDaysStr,
      });

      // Call userDecrypt exactly as in documentation
      const result = await fhevmInstance.userDecrypt(
        handleContractPairs,
        keypair.privateKey,
        keypair.publicKey,
        cleanSignature,
        contractAddresses,
        userAddress,
        startTimeStampStr,
        durationDaysStr,
      );

      console.log('Decryption result:', result);

      // Get decrypted value using the ciphertext handle as key
      const decryptedValue = result[ciphertextHandle];

      if (decryptedValue !== undefined) {
        // Convert decrypted value to readable format (assuming 6 decimals)
        return ethers.formatUnits(BigInt(decryptedValue), 6);
      }

      console.log('No decrypted value found in result');
      return null;
    } catch (err) {
      console.error('Error decrypting balance:', err);
      return null;
    }
  }, [provider, signer]);

  const mintTokens = useCallback(async (currency: 'USDC' | 'USDT', amount: string) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const tokenAddress = currency === 'USDC' ? CONTRACTS.MockUSDC : CONTRACTS.MockUSDT;
      const token = new ethers.Contract(tokenAddress, MockERC20ABI.abi, signer);
      
      // Parse amount (6 decimals)
      const parsedAmount = ethers.parseUnits(amount, 6);
      
      console.log(`Minting ${amount} ${currency}...`);
      const tx = await token.mint(await signer.getAddress(), parsedAmount);
      await tx.wait();
      console.log('Mint confirmed');
      
      return tx.hash;
    } catch (err: any) {
      console.error('Mint error:', err);
      setError(err.message || 'Mint failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [signer]);

  const withdraw = useCallback(async (currency: 'USDC' | 'USDT', amount: string, recipient?: string) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get the pool key
      const poolKey = getPoolKey();
      
      // Get currency address
      const currencyAddress = currency === 'USDC' ? CONTRACTS.MockUSDC : CONTRACTS.MockUSDT;
      
      // Parse amount (assuming 6 decimals for both USDC and USDT)
      const parsedAmount = ethers.parseUnits(amount, 6);
      
      // Use sender as recipient if no recipient provided
      const finalRecipient = recipient || await signer.getAddress();
      
      // Create contract instance
      const hook = new ethers.Contract(CONTRACTS.UniversalPrivacyHook, UniversalPrivacyHookABI.abi, signer);
      
      // Withdraw with gas buffer
      console.log('Withdrawing tokens...');
      const estimatedGas = await hook.withdraw.estimateGas(poolKey, currencyAddress, parsedAmount, finalRecipient);
      const gasLimit = estimatedGas * BigInt(120) / BigInt(100);
      
      const withdrawTx = await hook.withdraw(poolKey, currencyAddress, parsedAmount, finalRecipient, { gasLimit });
      await withdrawTx.wait();
      console.log('Withdraw confirmed');
      
      return withdrawTx.hash;
    } catch (err: any) {
      console.error('Withdraw error:', err);
      setError(err.message || 'Withdraw failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [signer]);

  return {
    deposit,
    withdraw,
    submitIntent,
    executeIntent,
    getEncryptedBalance,
    getRegularBalance,
    decryptBalance,
    listenForIntentDecrypted,
    checkIntentStatus,
    fetchUserIntents,
    mintTokens,
    loading,
    error
  };
};