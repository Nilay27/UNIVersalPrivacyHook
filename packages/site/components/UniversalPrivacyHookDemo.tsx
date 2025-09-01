"use client";

import { useState, useEffect } from 'react';
import { useUniversalPrivacyHook } from '../hooks/useUniversalPrivacyHook';
import { useMetaMaskEthersSigner } from '../hooks/metamask/useMetaMaskEthersSigner';
import { CONTRACTS } from '../config/contracts';
import { useFhevm } from '../fhevm/useFhevm';
import { ethers } from 'ethers';
import { useInMemoryStorage } from '../hooks/useInMemoryStorage';
import toast from 'react-hot-toast';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

export function UniversalPrivacyHookDemo() {
  const { ethersSigner: signer, isConnected, connect, provider, chainId } = useMetaMaskEthersSigner();
  const [isCorrectNetwork, setIsCorrectNetwork] = useState(false);
  
  // Check if we're on Sepolia
  useEffect(() => {
    setIsCorrectNetwork(chainId === 11155111); // Sepolia chainId
  }, [chainId]);
  
  const { storage: fhevmDecryptionSignatureStorage } = useInMemoryStorage();
  
  const { instance: fhevmInstance } = useFhevm({
    provider: provider as any, // BrowserProvider type compatibility
    chainId: chainId,
    enabled: isConnected && isCorrectNetwork
  });
  const { 
    deposit, 
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
  } = useUniversalPrivacyHook();

  // Deposit state
  const [depositCurrency, setDepositCurrency] = useState<'USDC' | 'USDT'>('USDC');
  const [depositAmount, setDepositAmount] = useState('100');
  
  // Swap state
  const [tokenIn, setTokenIn] = useState<'USDC' | 'USDT'>('USDC');
  const [tokenOut, setTokenOut] = useState<'USDC' | 'USDT'>('USDT');
  const [swapAmount, setSwapAmount] = useState('10');
  const [activeTab, setActiveTab] = useState<'deposit' | 'swap'>('deposit');
  
  // Intent tracking
  const [submittedIntents, setSubmittedIntents] = useState<Array<{
    id: string;
    status: 'pending' | 'decrypted' | 'executed';
    amount?: string;
    tokenIn: string;
    tokenOut: string;
    timestamp: number;
    blockNumber?: number;
  }>>([]);
  const [isLoadingIntents, setIsLoadingIntents] = useState(false);
  const [processedIntents, setProcessedIntents] = useState<Set<string>>(new Set());
  
  // Load processed intents from local storage on mount
  useEffect(() => {
    const stored = localStorage.getItem('processedIntents');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setProcessedIntents(new Set(parsed));
      } catch {
        console.error('Failed to parse processed intents from localStorage');
      }
    }
  }, []);
  
  // Save processed intents to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('processedIntents', JSON.stringify(Array.from(processedIntents)));
  }, [processedIntents]);
  
  // Regular balances
  const [balanceUSDC, setBalanceUSDC] = useState<string | null>(null);
  const [balanceUSDT, setBalanceUSDT] = useState<string | null>(null);
  
  // Encrypted balances
  const [encBalanceUSDC, setEncBalanceUSDC] = useState<string | null>(null);
  const [encBalanceUSDT, setEncBalanceUSDT] = useState<string | null>(null);
  
  // Decrypted balances (for display)
  const [decryptedBalanceUSDC, setDecryptedBalanceUSDC] = useState<string | null>(null);
  const [decryptedBalanceUSDT, setDecryptedBalanceUSDT] = useState<string | null>(null);
  const [isDecryptingUSDC, setIsDecryptingUSDC] = useState(false);
  const [isDecryptingUSDT, setIsDecryptingUSDT] = useState(false);
  
  // Faucet state
  const [faucetAmount, setFaucetAmount] = useState('1000');
  const [faucetCurrency, setFaucetCurrency] = useState<'USDC' | 'USDT'>('USDC');

  // Load all balances
  useEffect(() => {
    const loadBalances = async () => {
      // Load regular balances
      const regularUSDC = await getRegularBalance('USDC');
      const regularUSDT = await getRegularBalance('USDT');
      setBalanceUSDC(regularUSDC);
      setBalanceUSDT(regularUSDT);
      
      // Load encrypted balances
      const encUSDC = await getEncryptedBalance('USDC');
      const encUSDT = await getEncryptedBalance('USDT');
      
      // If encrypted balance changed, clear decrypted values
      if (encUSDC !== encBalanceUSDC) {
        setDecryptedBalanceUSDC(null);
      }
      if (encUSDT !== encBalanceUSDT) {
        setDecryptedBalanceUSDT(null);
      }
      
      setEncBalanceUSDC(encUSDC);
      setEncBalanceUSDT(encUSDT);
    };
    
    if (signer && isCorrectNetwork) {
      loadBalances();
      const interval = setInterval(loadBalances, 10000);
      return () => clearInterval(interval);
    }
  }, [signer, isCorrectNetwork, getEncryptedBalance, getRegularBalance, encBalanceUSDC, encBalanceUSDT]);
  
  // Load user intents from blockchain
  useEffect(() => {
    const loadIntents = async () => {
      if (!signer || !isCorrectNetwork) return;
      
      setIsLoadingIntents(true);
      try {
        const intents = await fetchUserIntents();
        console.log('Loaded intents from blockchain:', intents);
        
        // Convert to our format and filter out locally processed intents
        const formattedIntents = intents
          .filter(intent => !processedIntents.has(intent.id)) // Filter out locally processed
          .map(intent => ({
            id: intent.id,
            status: intent.executed ? 'executed' as const : 
                    intent.decryptedAmount ? 'decrypted' as const : 
                    'pending' as const,
            amount: intent.decryptedAmount || undefined,
            tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut,
            timestamp: intent.timestamp * 1000, // Convert to milliseconds
            blockNumber: intent.blockNumber
          }));
        
        setSubmittedIntents(formattedIntents);
      } catch (err) {
        console.error('Failed to load intents:', err);
      } finally {
        setIsLoadingIntents(false);
      }
    };
    
    loadIntents();
    // No automatic refresh - only manual refresh to avoid timeouts
  }, [signer, isCorrectNetwork, fetchUserIntents, processedIntents]);
  
  // Decrypt USDC balance
  const handleDecryptUSDC = async () => {
    if (!fhevmInstance || !signer || !fhevmDecryptionSignatureStorage) {
      console.error('Missing requirements for decryption');
      return;
    }
    
    if (!encBalanceUSDC || encBalanceUSDC === '0' || encBalanceUSDC === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      console.log('No encrypted USDC balance to decrypt');
      return;
    }
    
    console.log('Decrypting USDC balance handle:', encBalanceUSDC);
    setIsDecryptingUSDC(true);
    try {
      const decryptedUSDC = await decryptBalance(
        encBalanceUSDC,
        CONTRACTS.EncryptedUSDC,
        fhevmInstance,
        fhevmDecryptionSignatureStorage
      );
      console.log('Decrypted USDC balance:', decryptedUSDC);
      setDecryptedBalanceUSDC(decryptedUSDC);
    } catch (err) {
      console.error('Error decrypting USDC balance:', err);
    } finally {
      setIsDecryptingUSDC(false);
    }
  };
  
  // Decrypt USDT balance
  const handleDecryptUSDT = async () => {
    if (!fhevmInstance || !signer || !fhevmDecryptionSignatureStorage) {
      console.error('Missing requirements for decryption');
      return;
    }
    
    if (!encBalanceUSDT || encBalanceUSDT === '0' || encBalanceUSDT === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      console.log('No encrypted USDT balance to decrypt');
      return;
    }
    
    console.log('Decrypting USDT balance handle:', encBalanceUSDT);
    setIsDecryptingUSDT(true);
    try {
      const decryptedUSDT = await decryptBalance(
        encBalanceUSDT,
        CONTRACTS.EncryptedUSDT,
        fhevmInstance,
        fhevmDecryptionSignatureStorage
      );
      console.log('Decrypted USDT balance:', decryptedUSDT);
      setDecryptedBalanceUSDT(decryptedUSDT);
    } catch (err) {
      console.error('Error decrypting USDT balance:', err);
    } finally {
      setIsDecryptingUSDT(false);
    }
  };

  // Listen for decrypted intents
  useEffect(() => {
    const cleanup = listenForIntentDecrypted((intentId, amount) => {
      console.log(`Intent ${intentId} decrypted with amount: ${amount}`);
      setSubmittedIntents(prev => 
        prev.map(intent => 
          intent.id === intentId 
            ? { ...intent, status: 'decrypted', amount } 
            : intent
        )
      );
      
      // For now, don't auto-execute - let user manually execute
      // In production, this would be handled by an executor service
    });
    
    return cleanup;
  }, [listenForIntentDecrypted]);
  
  // Check if intent is decrypted
  const checkIntentDecryption = async (intentId: string) => {
    const status = await checkIntentStatus(intentId);
    if (status?.isDecrypted && !status.isExecuted) {
      console.log(`Intent ${intentId} is decrypted with amount: ${status.amount}`);
      setSubmittedIntents(prev => 
        prev.map(intent => 
          intent.id === intentId 
            ? { ...intent, status: 'decrypted', amount: status.amount || undefined } 
            : intent
        )
      );
    } else if (!status?.isDecrypted) {
      // Check again in a few seconds
      setTimeout(() => {
        checkIntentDecryption(intentId);
      }, 5000);
    }
  };
  
  // Manual execute intent
  const handleExecuteIntent = async (intentId: string) => {
    try {
      console.log('Manually executing intent:', intentId);
      const txHash = await executeIntent(intentId);
      console.log('Intent executed successfully:', txHash);
      
      // Mark as processed in local storage
      setProcessedIntents(prev => new Set([...prev, intentId]));
      
      // Update UI immediately
      setSubmittedIntents(prev => 
        prev.filter(intent => intent.id !== intentId)
      );
      
      // Log transaction hash
      console.log('Execution completed with txHash:', txHash);
      
      // Refresh balances after execution
      setTimeout(async () => {
        const regularUSDC = await getRegularBalance('USDC');
        const regularUSDT = await getRegularBalance('USDT');
        setBalanceUSDC(regularUSDC);
        setBalanceUSDT(regularUSDT);
        
        const encUSDC = await getEncryptedBalance('USDC');
        const encUSDT = await getEncryptedBalance('USDT');
        
        if (encUSDC !== encBalanceUSDC) setDecryptedBalanceUSDC(null);
        if (encUSDT !== encBalanceUSDT) setDecryptedBalanceUSDT(null);
        
        setEncBalanceUSDC(encUSDC);
        setEncBalanceUSDT(encUSDT);
      }, 3000);
      
      // Show transaction link in toast
      toast.success(
        <div>
          <p className="font-semibold mb-2">Swap executed successfully!</p>
          <a 
            href={`https://sepolia.etherscan.io/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline text-xs break-all"
          >
            View transaction →
          </a>
        </div>,
        { duration: 6000 }
      );
      
      // Immediately refresh the intent list to remove the executed intent
      setIsLoadingIntents(true);
      fetchUserIntents().then(intents => {
        const formattedIntents = intents.map(intent => ({
          id: intent.id,
          status: intent.executed ? 'executed' as const : 
                  intent.decryptedAmount ? 'decrypted' as const : 
                  'pending' as const,
          amount: intent.decryptedAmount || undefined,
          tokenIn: intent.tokenIn,
          tokenOut: intent.tokenOut,
          timestamp: intent.timestamp * 1000,
          blockNumber: intent.blockNumber
        }));
        setSubmittedIntents(formattedIntents);
        setIsLoadingIntents(false);
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Failed to execute intent:', err);
      toast.error(`Failed to execute intent: ${errorMessage}`);
    }
  };

  const switchToSepolia = async () => {
    if (!window.ethereum) return;
    
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xaa36a7' }], // 0xaa36a7 is hex for 11155111 (Sepolia)
      });
    } catch (switchError: unknown) {
      // This error code indicates that the chain has not been added to MetaMask
      if (switchError && typeof switchError === 'object' && 'code' in switchError && switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xaa36a7',
              chainName: 'Sepolia',
              nativeCurrency: {
                name: 'SepoliaETH',
                symbol: 'ETH',
                decimals: 18
              },
              rpcUrls: ['https://rpc.sepolia.org'],
              blockExplorerUrls: ['https://sepolia.etherscan.io/']
            }],
          });
        } catch (addError) {
          console.error('Failed to add Sepolia network:', addError);
        }
      }
    }
  };

  const handleDeposit = async () => {
    try {
      const txHash = await deposit(depositCurrency, depositAmount);
      console.log('Deposit successful:', txHash);
      
      // Show transaction link in toast
      if (txHash) {
        toast.success(
          <div>
            <p className="font-semibold mb-2">Deposit successful!</p>
            <a 
              href={`https://sepolia.etherscan.io/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline text-xs break-all"
            >
              View transaction →
            </a>
          </div>,
          { duration: 6000 }
        );
      }
      
      // Refresh all balances after deposit
      setTimeout(async () => {
        // Regular balances
        const regularUSDC = await getRegularBalance('USDC');
        const regularUSDT = await getRegularBalance('USDT');
        setBalanceUSDC(regularUSDC);
        setBalanceUSDT(regularUSDT);
        
        // Encrypted balances
        const encUSDC = await getEncryptedBalance('USDC');
        const encUSDT = await getEncryptedBalance('USDT');
        
        // Clear decrypted values if balance changed
        if (encUSDC !== encBalanceUSDC) setDecryptedBalanceUSDC(null);
        if (encUSDT !== encBalanceUSDT) setDecryptedBalanceUSDT(null);
        
        setEncBalanceUSDC(encUSDC);
        setEncBalanceUSDT(encUSDT);
      }, 3000);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Deposit failed:', err);
      toast.error(`Deposit failed: ${errorMessage}`);
    }
  };

  const handleSubmitIntent = async () => {
    try {
      if (!fhevmInstance || !signer) {
        toast.error('FHEVM not initialized or wallet not connected. Please wait...');
        return;
      }
      
      // Check if user has encrypted balance for the input token
      const encBalance = tokenIn === 'USDC' ? encBalanceUSDC : encBalanceUSDT;
      if (!encBalance || encBalance === '0' || encBalance === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        toast.error(`You need to deposit ${tokenIn} first to get encrypted tokens before you can submit a private swap intent.`);
        return;
      }

      // Parse amount to proper units (6 decimals)
      const parsedAmount = ethers.parseUnits(swapAmount, 6);
      
      // Create encrypted input
      const input = fhevmInstance.createEncryptedInput(
        CONTRACTS.UniversalPrivacyHook,
        await signer.getAddress()
      );
      
      // Add the amount as euint128 - the contract expects 128-bit encrypted values
      const amountBigInt = BigInt(parsedAmount.toString());
      console.log('Encrypting amount:', ethers.formatUnits(amountBigInt, 6), 'tokens');
      
      // Try to use add128 if available, otherwise fall back to add64
      if (typeof (input as any).add128 === 'function') {
        console.log('Using add128 for encryption');
        (input as any).add128(Number(amountBigInt));
      } else if (typeof (input as any).add64 === 'function') {
        console.log('Warning: Using add64 instead of add128 - this might cause issues');
        // For amounts that don't fit in 64 bits, we need to handle carefully
        if (amountBigInt <= BigInt(2) ** BigInt(64) - BigInt(1)) {
          input.add64(Number(amountBigInt));
        } else {
          console.error('Amount too large for add64, using MAX_SAFE_INTEGER');
          input.add64(Number.MAX_SAFE_INTEGER);
        }
      } else {
        console.error('No suitable encryption method found');
        throw new Error('Cannot encrypt amount - no add128 or add64 method available');
      }
      
      // Encrypt the input
      const encrypted = await input.encrypt();
      console.log('Encrypted amount handle:', encrypted.handles[0]);
      console.log('Input proof length:', encrypted.inputProof.length, 'bytes');
      
      // Convert Uint8Array to hex string properly
      const inputProofHex = '0x' + Array.from(encrypted.inputProof as Uint8Array)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      console.log('Submitting intent with:');
      console.log('- Token In:', tokenIn);
      console.log('- Token Out:', tokenOut);
      console.log('- Encrypted handle:', encrypted.handles[0]);
      console.log('- Input proof (hex):', inputProofHex.slice(0, 20) + '...');
      
      const result = await submitIntent(
        tokenIn,
        tokenOut,
        encrypted.handles[0],
        inputProofHex
      );
      
      if (result?.intentId) {
        console.log('✅ Intent submitted successfully! Intent ID:', result.intentId);
        setSubmittedIntents(prev => [...prev, { 
          id: result.intentId, 
          status: 'pending',
          tokenIn,
          tokenOut,
          timestamp: Date.now()
        }]);
        
        // Show transaction link in toast
        toast.success(
          <div>
            <p className="font-semibold mb-2">Intent submitted!</p>
            <p className="text-xs mb-2 opacity-90">ID: {result.intentId.slice(0, 10)}...{result.intentId.slice(-8)}</p>
            {result.txHash && (
              <a 
                href={`https://sepolia.etherscan.io/tx/${result.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline text-xs"
              >
                View transaction →
              </a>
            )}
            <p className="text-xs mt-2 opacity-75">The FHE Gateway will decrypt your intent shortly.</p>
          </div>,
          { duration: 8000 }
        );
        
        // Refresh the intent list immediately
        if (signer) {
          setIsLoadingIntents(true);
          fetchUserIntents().then(intents => {
            const formattedIntents = intents
              .filter(intent => !processedIntents.has(intent.id))
              .map(intent => ({
                id: intent.id,
                status: intent.executed ? 'executed' as const : 
                        intent.decryptedAmount ? 'decrypted' as const : 
                        'pending' as const,
                amount: intent.decryptedAmount || undefined,
                tokenIn: intent.tokenIn,
                tokenOut: intent.tokenOut,
                timestamp: intent.timestamp * 1000,
                blockNumber: intent.blockNumber
              }));
            setSubmittedIntents(formattedIntents);
            setIsLoadingIntents(false);
          });
        }
        
        // Start checking for decryption after a few seconds
        setTimeout(() => {
          checkIntentDecryption(result.intentId);
        }, 5000);
      } else {
        console.error('Intent submission completed but no intent ID received');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Submit intent failed:', err);
      toast.error(`Failed to submit intent: ${errorMessage}`);
    }
  };

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto mt-20">
        <div className="bg-white rounded-3xl shadow-2xl p-8 backdrop-blur-lg bg-opacity-95">
          <div className="text-center space-y-6">
            <div className="flex justify-center">
              <div className="bg-gradient-to-r from-pink-500 to-purple-600 p-1 rounded-2xl">
                <div className="bg-white p-4 rounded-2xl">
                  <svg className="w-16 h-16 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
              </div>
            </div>
            <h2 className="text-3xl font-bold bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-transparent">
              Universal Privacy Hook
            </h2>
            <p className="text-gray-600">Private swaps powered by Fully Homomorphic Encryption</p>
            <button
              onClick={connect}
              className="w-full bg-gradient-to-r from-pink-500 to-purple-600 text-white py-4 px-6 rounded-2xl font-semibold hover:shadow-lg transform hover:scale-105 transition-all duration-200"
            >
              Connect Wallet
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Show network switch prompt if on wrong network
  if (isConnected && !isCorrectNetwork) {
    return (
      <div className="max-w-lg mx-auto mt-20">
        <div className="bg-white rounded-3xl shadow-2xl p-8 backdrop-blur-lg bg-opacity-95">
          <div className="text-center space-y-6">
            <div className="flex justify-center">
              <div className="bg-gradient-to-r from-yellow-500 to-orange-600 p-1 rounded-2xl">
                <div className="bg-white p-4 rounded-2xl">
                  <svg className="w-16 h-16 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
              </div>
            </div>
            <h2 className="text-3xl font-bold bg-gradient-to-r from-yellow-500 to-orange-600 bg-clip-text text-transparent">
              Wrong Network
            </h2>
            <p className="text-gray-600">
              Please switch to Sepolia network to use this dApp
            </p>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-sm text-gray-500 mb-2">Current network:</p>
              <p className="font-semibold text-gray-800">
                {chainId === 31337 ? 'Localhost' : 
                 chainId === 1 ? 'Ethereum Mainnet' : 
                 `Chain ID: ${chainId}`}
              </p>
            </div>
            <button
              onClick={switchToSepolia}
              className="w-full bg-gradient-to-r from-yellow-500 to-orange-600 text-white py-4 px-6 rounded-2xl font-semibold hover:shadow-lg transform hover:scale-105 transition-all duration-200"
            >
              Switch to Sepolia
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-5xl font-bold bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-transparent mb-2">
          Universal Privacy Hook
        </h1>
        <p className="text-gray-600 text-lg">Swap tokens privately using FHE on Uniswap V4</p>
      </div>

      {/* Balance Cards - Top Section */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* Regular Balances */}
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            Regular Tokens
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center p-3 bg-blue-50 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold">
                  U
                </div>
                <span className="font-semibold">USDC</span>
              </div>
              <span className="text-xl font-bold">{balanceUSDC || '0.00'}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-green-50 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center text-white font-bold">
                  T
                </div>
                <span className="font-semibold">USDT</span>
              </div>
              <span className="text-xl font-bold">{balanceUSDT || '0.00'}</span>
            </div>
          </div>
        </div>

        {/* Encrypted Balances */}
        <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-2xl shadow-lg p-6">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Encrypted Tokens
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center p-3 bg-white bg-opacity-70 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                  eU
                </div>
                <span className="font-semibold">eUSDC</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold font-mono">
                  {decryptedBalanceUSDC ? (
                    <span className="text-green-600">{decryptedBalanceUSDC}</span>
                  ) : (
                    <span className="text-gray-500">
                      {encBalanceUSDC && encBalanceUSDC !== '0' ? 
                        Number(encBalanceUSDC).toExponential(2) : 
                        '0'}
                    </span>
                  )}
                </span>
                {encBalanceUSDC && encBalanceUSDC !== '0' && !decryptedBalanceUSDC && (
                  <button
                    onClick={handleDecryptUSDC}
                    disabled={isDecryptingUSDC || !fhevmInstance || !signer}
                    className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isDecryptingUSDC ? '...' : 'Decrypt'}
                  </button>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center p-3 bg-white bg-opacity-70 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-r from-green-500 to-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                  eT
                </div>
                <span className="font-semibold">eUSDT</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold font-mono">
                  {decryptedBalanceUSDT ? (
                    <span className="text-green-600">{decryptedBalanceUSDT}</span>
                  ) : (
                    <span className="text-gray-500">
                      {encBalanceUSDT && encBalanceUSDT !== '0' ? 
                        Number(encBalanceUSDT).toExponential(2) : 
                        '0'}
                    </span>
                  )}
                </span>
                {encBalanceUSDT && encBalanceUSDT !== '0' && !decryptedBalanceUSDT && (
                  <button
                    onClick={handleDecryptUSDT}
                    disabled={isDecryptingUSDT || !fhevmInstance || !signer}
                    className="text-xs bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isDecryptingUSDT ? '...' : 'Decrypt'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Trading Card */}
      <div className="bg-white rounded-3xl shadow-2xl p-1 backdrop-blur-lg bg-opacity-95">
        <div className="bg-gradient-to-r from-pink-500 to-purple-600 p-[2px] rounded-3xl">
          <div className="bg-white rounded-3xl p-6">
            {/* Tab Switcher */}
            <div className="flex mb-6 bg-gray-100 rounded-2xl p-1">
              <button
                onClick={() => setActiveTab('deposit')}
                className={`flex-1 py-3 px-6 rounded-xl font-semibold transition-all duration-200 ${
                  activeTab === 'deposit'
                    ? 'bg-white text-purple-600 shadow-md'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Deposit
              </button>
              <button
                onClick={() => setActiveTab('swap')}
                className={`flex-1 py-3 px-6 rounded-xl font-semibold transition-all duration-200 ${
                  activeTab === 'swap'
                    ? 'bg-white text-purple-600 shadow-md'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Private Swap
              </button>
            </div>

            {/* Deposit Tab */}
            {activeTab === 'deposit' && (
              <div className="space-y-6">
                <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-2xl p-6">
                  <h3 className="font-semibold text-lg mb-4 text-gray-800">Deposit Tokens</h3>
                  <p className="text-sm text-gray-600 mb-6">
                    Convert regular tokens to encrypted tokens for private swaps
                  </p>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Select Token</label>
                      <div className="flex gap-2">
                        {(['USDC', 'USDT'] as const).map((token) => (
                          <button
                            key={token}
                            onClick={() => setDepositCurrency(token)}
                            className={`flex-1 py-3 px-4 rounded-xl font-semibold transition-all duration-200 ${
                              depositCurrency === token
                                ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg'
                                : 'bg-white border-2 border-gray-200 hover:border-purple-400'
                            }`}
                          >
                            {token}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Amount</label>
                      <div className="relative">
                        <input
                          type="text"
                          value={depositAmount}
                          onChange={(e) => setDepositAmount(e.target.value)}
                          className="w-full py-4 px-6 pr-20 bg-white border-2 border-gray-200 rounded-2xl text-lg font-semibold focus:border-purple-500 focus:outline-none transition-colors"
                          placeholder="0.0"
                        />
                        <span className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-500 font-semibold">
                          {depositCurrency}
                        </span>
                      </div>
                    </div>
                    
                    <button
                      onClick={handleDeposit}
                      disabled={loading || !depositAmount || parseFloat(depositAmount) <= 0}
                      className="w-full bg-gradient-to-r from-pink-500 to-purple-600 text-white py-4 px-6 rounded-2xl font-semibold hover:shadow-lg transform hover:scale-[1.02] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading ? 'Processing...' : 'Deposit'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Swap Tab */}
            {activeTab === 'swap' && (
              <div className="space-y-6">
                <div className="space-y-4">
                  {/* From Token */}
                  <div className="bg-gray-50 rounded-2xl p-6">
                    <div className="flex justify-between mb-3">
                      <label className="text-sm font-medium text-gray-600">From (Encrypted)</label>
                      <span className="text-sm text-gray-500">
                        Balance: {tokenIn === 'USDC' ? encBalanceUSDC : encBalanceUSDT} {tokenIn}
                      </span>
                    </div>
                    <div className="flex gap-4">
                      <input
                        type="text"
                        value={swapAmount}
                        onChange={(e) => setSwapAmount(e.target.value)}
                        className="flex-1 bg-transparent text-3xl font-bold outline-none"
                        placeholder="0.0"
                      />
                      <select
                        value={tokenIn}
                        onChange={(e) => setTokenIn(e.target.value as 'USDC' | 'USDT')}
                        className="bg-white px-4 py-2 rounded-xl font-semibold border-2 border-gray-200 focus:border-purple-500 outline-none"
                      >
                        <option value="USDC">USDC</option>
                        <option value="USDT">USDT</option>
                      </select>
                    </div>
                  </div>

                  {/* Swap Icon */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => {
                        setTokenIn(tokenOut);
                        setTokenOut(tokenIn);
                      }}
                      className="bg-white border-4 border-gray-100 rounded-2xl p-3 hover:border-purple-500 transition-colors"
                    >
                      <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                      </svg>
                    </button>
                  </div>

                  {/* To Token */}
                  <div className="bg-gray-50 rounded-2xl p-6">
                    <div className="flex justify-between mb-3">
                      <label className="text-sm font-medium text-gray-600">To (Encrypted)</label>
                      <span className="text-sm text-gray-500">
                        Balance: {tokenOut === 'USDC' ? encBalanceUSDC : encBalanceUSDT} {tokenOut}
                      </span>
                    </div>
                    <div className="flex gap-4">
                      <input
                        type="text"
                        value={swapAmount}
                        readOnly
                        className="flex-1 bg-transparent text-3xl font-bold outline-none text-gray-400"
                        placeholder="0.0"
                      />
                      <select
                        value={tokenOut}
                        onChange={(e) => setTokenOut(e.target.value as 'USDC' | 'USDT')}
                        className="bg-white px-4 py-2 rounded-xl font-semibold border-2 border-gray-200 focus:border-purple-500 outline-none"
                      >
                        <option value="USDC">USDC</option>
                        <option value="USDT">USDT</option>
                      </select>
                    </div>
                  </div>

                  {/* Privacy Notice */}
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-2xl p-4 flex items-center gap-3">
                    <svg className="w-5 h-5 text-purple-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <p className="text-sm text-gray-700">
                      Your swap amount is encrypted using FHE. No one can see the actual amount until execution.
                    </p>
                  </div>

                  <button
                    onClick={handleSubmitIntent}
                    disabled={loading || tokenIn === tokenOut || !swapAmount || parseFloat(swapAmount) <= 0}
                    className="w-full bg-gradient-to-r from-pink-500 to-purple-600 text-white py-4 px-6 rounded-2xl font-semibold hover:shadow-lg transform hover:scale-[1.02] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? 'Processing...' : 'Submit Private Swap'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Intent History */}
      <div className="bg-white rounded-3xl shadow-xl p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Intent History (Last Hour)
          </h3>
          <div className="flex items-center gap-2">
            {isLoadingIntents && (
              <span className="text-sm text-gray-500">Loading...</span>
            )}
            <button
              onClick={async () => {
                setIsLoadingIntents(true);
                const intents = await fetchUserIntents();
                const formattedIntents = intents
                  .filter(intent => !processedIntents.has(intent.id))
                  .map(intent => ({
                    id: intent.id,
                    status: intent.executed ? 'executed' as const : 
                            intent.decryptedAmount ? 'decrypted' as const : 
                            'pending' as const,
                    amount: intent.decryptedAmount || undefined,
                    tokenIn: intent.tokenIn,
                    tokenOut: intent.tokenOut,
                    timestamp: intent.timestamp * 1000,
                    blockNumber: intent.blockNumber
                  }));
                setSubmittedIntents(formattedIntents);
                setIsLoadingIntents(false);
              }}
              disabled={isLoadingIntents}
              className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
          <div className="space-y-3">
            {submittedIntents.length === 0 && !isLoadingIntents && (
              <div className="text-center py-8 text-gray-500">
                No pending intents in the last hour
              </div>
            )}
            {submittedIntents.map((intent) => (
              <div key={intent.id} className="bg-gradient-to-r from-gray-50 to-gray-100 rounded-2xl p-4">
                <div className="flex justify-between items-center">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-gray-600">
                        {intent.id.slice(0, 10)}...{intent.id.slice(-8)}
                      </span>
                      <span className="text-sm text-gray-500">
                        • {intent.tokenIn} → {intent.tokenOut}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {new Date(intent.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {intent.amount && (
                      <span className="text-sm font-semibold text-gray-700">{intent.amount} tokens</span>
                    )}
                    {intent.status === 'decrypted' && (
                      <button
                        onClick={() => handleExecuteIntent(intent.id)}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition-colors"
                      >
                        Execute Swap
                      </button>
                    )}
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                      intent.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      intent.status === 'decrypted' ? 'bg-blue-100 text-blue-800' :
                      'bg-green-100 text-green-800'
                    }`}>
                      {intent.status === 'pending' ? '⏳ Decrypting' :
                       intent.status === 'decrypted' ? '🔓 Decrypted' :
                       '✅ Executed'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border-2 border-red-200 text-red-700 px-6 py-4 rounded-2xl flex items-center gap-3">
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{error}</p>
        </div>
      )}

      {/* Token Faucet */}
      <div className="bg-gradient-to-r from-blue-50 to-cyan-50 rounded-3xl shadow-lg p-6">
        <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
          <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Test Token Faucet
        </h3>
        <p className="text-sm text-gray-600 mb-4">Get test USDC or USDT tokens for testing the privacy hook</p>
        
        <div className="flex gap-3">
          <input
            type="text"
            value={faucetAmount}
            onChange={(e) => setFaucetAmount(e.target.value)}
            placeholder="Amount"
            className="flex-1 px-4 py-2 border-2 border-gray-200 rounded-xl focus:border-blue-500 outline-none"
          />
          <select
            value={faucetCurrency}
            onChange={(e) => setFaucetCurrency(e.target.value as 'USDC' | 'USDT')}
            className="px-4 py-2 border-2 border-gray-200 rounded-xl focus:border-blue-500 outline-none"
          >
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
          </select>
          <button
            onClick={async () => {
              try {
                const txHash = await mintTokens(faucetCurrency, faucetAmount);
                if (txHash) {
                  toast.success(
                    <div>
                      <p className="font-semibold mb-2">Minted {faucetAmount} {faucetCurrency}!</p>
                      <a 
                        href={`https://sepolia.etherscan.io/tx/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline text-xs"
                      >
                        View transaction →
                      </a>
                    </div>,
                    { duration: 6000 }
                  );
                  
                  // Refresh balances
                  setTimeout(async () => {
                    const balance = await getRegularBalance(faucetCurrency);
                    if (faucetCurrency === 'USDC') {
                      setBalanceUSDC(balance);
                    } else {
                      setBalanceUSDT(balance);
                    }
                  }, 3000);
                }
              } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                toast.error(`Failed to mint tokens: ${errorMessage}`);
              }
            }}
            disabled={loading || !faucetAmount || parseFloat(faucetAmount) <= 0}
            className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white px-6 py-2 rounded-xl font-semibold hover:shadow-lg transform hover:scale-[1.02] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Minting...' : 'Mint Tokens'}
          </button>
        </div>
      </div>

      {/* Contract Info Footer */}
      <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-2xl p-6">
        <h4 className="font-semibold text-gray-700 mb-3">Deployed Contracts (Sepolia)</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Hook:</span>
            <a href={`https://sepolia.etherscan.io/address/${CONTRACTS.UniversalPrivacyHook}`} target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">
              {CONTRACTS.UniversalPrivacyHook.slice(0, 8)}...{CONTRACTS.UniversalPrivacyHook.slice(-6)}
            </a>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Pool Manager:</span>
            <a href={`https://sepolia.etherscan.io/address/${CONTRACTS.PoolManager}`} target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">
              {CONTRACTS.PoolManager.slice(0, 8)}...{CONTRACTS.PoolManager.slice(-6)}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}