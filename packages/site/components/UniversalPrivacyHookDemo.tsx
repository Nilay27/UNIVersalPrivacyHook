"use client";

import { useState, useEffect } from 'react';
import { useUniversalPrivacyHook } from '../hooks/useUniversalPrivacyHook';
import { useMetaMaskEthersSigner } from '../hooks/metamask/useMetaMaskEthersSigner';
import { CONTRACTS } from '../config/contracts';
import { useFhevm } from '../fhevm/useFhevm';
import { ethers } from 'ethers';
import { useInMemoryStorage } from '../hooks/useInMemoryStorage';
import toast from 'react-hot-toast';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { 
  AlertCircle, 
  ArrowDownUp, 
  Clock, 
  Lock, 
  LogOut, 
  RefreshCw, 
  Wallet,
  Zap,
  Shield,
  Eye,
  DollarSign,
  Layers,
  Fuel
} from 'lucide-react';

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
  
  // Helper function to get token symbol from address
  const getTokenSymbol = (address: string): string => {
    if (!address) return 'Unknown';
    const lowerAddress = address.toLowerCase();
    // Check for USDC addresses
    if (lowerAddress === CONTRACTS.MockUSDC?.toLowerCase() || 
        lowerAddress === CONTRACTS.EncryptedUSDC?.toLowerCase() ||
        lowerAddress === '0x59dd1a3bd1256503cdc023bfc9f10e107d64c3c1') {
      return 'eUSDC';
    }
    // Check for USDT addresses
    if (lowerAddress === CONTRACTS.MockUSDT?.toLowerCase() || 
        lowerAddress === CONTRACTS.EncryptedUSDT?.toLowerCase() ||
        lowerAddress === '0xb1d9519e953b8513a4754f9b33d37edba90c001d') {
      return 'eUSDT';
    }
    return 'Unknown';
  };
  
  // Check if we're on Sepolia
  useEffect(() => {
    setIsCorrectNetwork(chainId === 11155111); // Sepolia chainId
  }, [chainId]);
  
  const { storage: fhevmDecryptionSignatureStorage } = useInMemoryStorage();
  
  const { instance: fhevmInstance } = useFhevm({
    provider: provider as any,
    chainId: chainId,
    enabled: isConnected && isCorrectNetwork
  });
  
  const { 
    deposit,
    withdraw, 
    submitIntent, 
    executeIntent,
    getEncryptedBalance,
    getRegularBalance,
    decryptBalance,
    fetchUserIntents,
    mintTokens,
    loading
  } = useUniversalPrivacyHook();

  // State management
  const [depositCurrency, setDepositCurrency] = useState<'USDC' | 'USDT'>('USDC');
  const [depositAmount, setDepositAmount] = useState('');
  
  const [withdrawCurrency, setWithdrawCurrency] = useState<'USDC' | 'USDT'>('USDC');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawRecipient, setWithdrawRecipient] = useState('');
  
  const [tokenIn, setTokenIn] = useState<'USDC' | 'USDT'>('USDC');
  const [tokenOut, setTokenOut] = useState<'USDC' | 'USDT'>('USDT');
  const [swapAmount, setSwapAmount] = useState('');
  
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
  
  // Balances
  const [balanceUSDC, setBalanceUSDC] = useState<string | null>(null);
  const [balanceUSDT, setBalanceUSDT] = useState<string | null>(null);
  const [encBalanceUSDC, setEncBalanceUSDC] = useState<string | null>(null);
  const [encBalanceUSDT, setEncBalanceUSDT] = useState<string | null>(null);
  const [decryptedBalanceUSDC, setDecryptedBalanceUSDC] = useState<string | null>(null);
  const [decryptedBalanceUSDT, setDecryptedBalanceUSDT] = useState<string | null>(null);
  const [isDecryptingUSDC, setIsDecryptingUSDC] = useState(false);
  const [isDecryptingUSDT, setIsDecryptingUSDT] = useState(false);
  
  // Loading states
  const [isSubmittingSwap, setIsSubmittingSwap] = useState(false);
  const [executingIntentId, setExecutingIntentId] = useState<string | null>(null);
  
  // Faucet state
  const [faucetAmount, setFaucetAmount] = useState('100');
  const [faucetCurrency, setFaucetCurrency] = useState<'USDC' | 'USDT'>('USDC');
  const [lastFaucetTime, setLastFaucetTime] = useState<{ [key: string]: number }>({});

  // Load processed intents from local storage
  useEffect(() => {
    const stored = localStorage.getItem('processedIntents');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setProcessedIntents(new Set(parsed));
      } catch {
        console.error('Failed to parse processed intents');
      }
    }
  }, []);
  
  // Save processed intents
  useEffect(() => {
    localStorage.setItem('processedIntents', JSON.stringify(Array.from(processedIntents)));
  }, [processedIntents]);

  // Load balances
  useEffect(() => {
    const loadBalances = async () => {
      const regularUSDC = await getRegularBalance('USDC');
      const regularUSDT = await getRegularBalance('USDT');
      setBalanceUSDC(regularUSDC);
      setBalanceUSDT(regularUSDT);
      
      const encUSDC = await getEncryptedBalance('USDC');
      const encUSDT = await getEncryptedBalance('USDT');
      
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

  // Load user intents
  useEffect(() => {
    const loadIntents = async () => {
      if (!signer || !isCorrectNetwork) return;
      
      setIsLoadingIntents(true);
      try {
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
      } catch (err) {
        console.error('Failed to load intents:', err);
      } finally {
        setIsLoadingIntents(false);
      }
    };
    
    loadIntents();
  }, [signer, isCorrectNetwork, fetchUserIntents, processedIntents]);

  // Handlers
  const handleDecryptUSDC = async () => {
    if (!fhevmInstance || !signer || !fhevmDecryptionSignatureStorage) return;
    if (!encBalanceUSDC || encBalanceUSDC === '0' || encBalanceUSDC === '0x0000000000000000000000000000000000000000000000000000000000000000') return;
    
    setIsDecryptingUSDC(true);
    try {
      const decryptedUSDC = await decryptBalance(
        encBalanceUSDC,
        CONTRACTS.EncryptedUSDC,
        fhevmInstance,
        fhevmDecryptionSignatureStorage
      );
      setDecryptedBalanceUSDC(decryptedUSDC);
    } catch (err) {
      console.error('Error decrypting USDC balance:', err);
    } finally {
      setIsDecryptingUSDC(false);
    }
  };
  
  const handleDecryptUSDT = async () => {
    if (!fhevmInstance || !signer || !fhevmDecryptionSignatureStorage) return;
    if (!encBalanceUSDT || encBalanceUSDT === '0' || encBalanceUSDT === '0x0000000000000000000000000000000000000000000000000000000000000000') return;
    
    setIsDecryptingUSDT(true);
    try {
      const decryptedUSDT = await decryptBalance(
        encBalanceUSDT,
        CONTRACTS.EncryptedUSDT,
        fhevmInstance,
        fhevmDecryptionSignatureStorage
      );
      setDecryptedBalanceUSDT(decryptedUSDT);
    } catch (err) {
      console.error('Error decrypting USDT balance:', err);
    } finally {
      setIsDecryptingUSDT(false);
    }
  };

  const handleDeposit = async () => {
    try {
      const txHash = await deposit(depositCurrency, depositAmount);
      if (txHash) {
        toast.success(
          <div>
            Deposit successful!
            <a 
              href={`https://sepolia.etherscan.io/tx/${txHash}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="block text-xs text-blue-600 hover:underline mt-1"
            >
              View transaction →
            </a>
          </div>
        );
        setDepositAmount('');
      }
    } catch (err: any) {
      toast.error(err.message || 'Deposit failed');
    }
  };

  const handleWithdraw = async () => {
    try {
      const txHash = await withdraw(withdrawCurrency, withdrawAmount, withdrawRecipient || undefined);
      if (txHash) {
        toast.success(
          <div>
            Withdrawal successful!
            <a 
              href={`https://sepolia.etherscan.io/tx/${txHash}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="block text-xs text-blue-600 hover:underline mt-1"
            >
              View transaction →
            </a>
          </div>
        );
        setWithdrawAmount('');
        setWithdrawRecipient('');
      }
    } catch (err: any) {
      toast.error(err.message || 'Withdraw failed');
    }
  };

  const handleSubmitIntent = async () => {
    // Prevent multiple clicks
    if (isSubmittingSwap) return;
    
    setIsSubmittingSwap(true);
    
    try {
      if (!fhevmInstance || !signer) {
        toast.error('FHEVM not initialized');
        return;
      }
      
      const encBalance = tokenIn === 'USDC' ? encBalanceUSDC : encBalanceUSDT;
      if (!encBalance || encBalance === '0') {
        toast.error(`Deposit ${tokenIn} first`);
        return;
      }

      const parsedAmount = ethers.parseUnits(swapAmount, 6);
      const input = fhevmInstance.createEncryptedInput(
        CONTRACTS.UniversalPrivacyHook,
        await signer.getAddress()
      );
      
      const amountBigInt = BigInt(parsedAmount.toString());
      console.log('Encrypting amount:', ethers.formatUnits(amountBigInt, 6), 'tokens');
      
      // Try passing BigInt directly like the AVS does
      if (typeof (input as any).add128 === 'function') {
        console.log('Using add128 for encryption with BigInt:', amountBigInt);
        try {
          // First try with BigInt directly (like AVS)
          (input as any).add128(amountBigInt);
        } catch (err) {
          console.log('BigInt failed, trying with Number:', err);
          (input as any).add128(Number(amountBigInt));
        }
      } else if (typeof (input as any).add64 === 'function') {
        console.log('Warning: Using add64 instead of add128');
        // For amounts that don't fit in 64 bits, we need to handle carefully
        if (amountBigInt <= BigInt(2) ** BigInt(64) - BigInt(1)) {
          input.add64(Number(amountBigInt));
        } else {
          console.error('Amount too large for add64, using MAX_SAFE_INTEGER');
          input.add64(Number.MAX_SAFE_INTEGER);
        }
      } else {
        console.error('No add128/add64, falling back to add32');
        input.add32(Number(amountBigInt));
      }
      
      const encrypted = await input.encrypt();
      
      // Convert handle to hex string
      const encryptedHandle = '0x' + Array.from(encrypted.handles[0] as Uint8Array)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      console.log('Encrypted handle:', encryptedHandle);
      console.log('Input proof length:', encrypted.inputProof.length, 'bytes');
      
      const inputProofHex = '0x' + Array.from(encrypted.inputProof as Uint8Array)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      console.log('Submitting intent with:');
      console.log('- Token In:', tokenIn);
      console.log('- Token Out:', tokenOut);
      console.log('- Encrypted handle:', encryptedHandle);
      console.log('- Input proof (first 20 chars):', inputProofHex.slice(0, 20) + '...');
      
      const result = await submitIntent(
        tokenIn,
        tokenOut,
        encryptedHandle,
        inputProofHex
      );
      
      if (result?.intentId) {
        toast.success(
          <div>
            Intent submitted!
            {result.txHash && (
              <a 
                href={`https://sepolia.etherscan.io/tx/${result.txHash}`} 
                target="_blank" 
                rel="noopener noreferrer"
                className="block text-xs text-blue-600 hover:underline mt-1"
              >
                View transaction →
              </a>
            )}
          </div>
        );
        setSwapAmount('');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to submit intent');
    } finally {
      setIsSubmittingSwap(false);
    }
  };

  const handleExecuteIntent = async (intentId: string) => {
    setExecutingIntentId(intentId);
    try {
      const txHash = await executeIntent(intentId);
      setProcessedIntents(prev => new Set([...prev, intentId]));
      setSubmittedIntents(prev => prev.filter(intent => intent.id !== intentId));
      toast.success(
        <div>
          Swap executed!
          <a 
            href={`https://sepolia.etherscan.io/tx/${txHash}`} 
            target="_blank" 
            rel="noopener noreferrer"
            className="block text-xs text-blue-600 hover:underline mt-1"
          >
            View transaction →
          </a>
        </div>
      );
    } catch (err: any) {
      console.error('Execute intent error:', err);
      if (err.message?.includes('0xe450d38c')) {
        toast.error('Intent may have already been executed or expired');
      } else if (err.message?.includes('insufficient')) {
        toast.error('Insufficient balance for swap');
      } else {
        toast.error(err.message || 'Failed to execute intent');
      }
    } finally {
      setExecutingIntentId(null);
    }
  };

  const switchToSepolia = async () => {
    if (!window.ethereum) return;
    
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xaa36a7' }],
      });
    } catch (switchError: any) {
      if (switchError.code === 4902) {
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
          console.error('Failed to add Sepolia:', addError);
        }
      }
    }
  };

  // Not connected state
  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 relative">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-orange-500/10 rounded-lg flex items-center justify-center mb-4">
              <Shield className="w-8 h-8 text-orange-500" />
            </div>
            <CardTitle className="text-2xl">Universal Privacy Hook</CardTitle>
            <CardDescription>
              Private DeFi trading powered by Fully Homomorphic Encryption
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={connect} className="w-full" size="lg" variant="default">
              <Wallet className="mr-2 h-5 w-5" />
              Connect Wallet
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Wrong network state
  if (isConnected && !isCorrectNetwork) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 relative">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-orange-500/10 rounded-lg flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-orange-500" />
            </div>
            <CardTitle className="text-2xl">Wrong Network</CardTitle>
            <CardDescription>
              Please switch to Sepolia testnet to continue
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-600 mb-1">Current network</p>
              <p className="font-semibold text-gray-900">
                {chainId === 31337 ? 'Localhost' : 
                 chainId === 1 ? 'Ethereum Mainnet' : 
                 `Chain ID: ${chainId}`}
              </p>
            </div>
            <Button onClick={switchToSepolia} className="w-full" size="lg" variant="default">
              Switch to Sepolia
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Main app
  return (
    <div className="relative min-h-screen p-3 sm:p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <Card className="bg-white/90 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">Total Value</CardTitle>
            <div className="p-2 bg-gradient-to-br from-green-400 to-emerald-500 rounded-lg">
              <DollarSign className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              ${((parseFloat(balanceUSDC || '0') + parseFloat(balanceUSDT || '0')) * 1).toFixed(2)}
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-white/90 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">Active Intents</CardTitle>
            <div className="p-2 bg-gradient-to-br from-blue-400 to-indigo-500 rounded-lg">
              <Layers className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{submittedIntents.length}</div>
          </CardContent>
        </Card>
        
        <Card className="bg-white/90 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">Gas Price</CardTitle>
            <div className="p-2 bg-gradient-to-br from-purple-400 to-pink-500 rounded-lg">
              <Fuel className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">~5 Gwei</div>
          </CardContent>
        </Card>
      </div>

      {/* Balance Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <Card className="bg-white/90 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-gray-400" />
              <span>Regular Tokens</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold">
                  U
                </div>
                <span className="font-semibold">USDC</span>
              </div>
              <span className="text-xl font-bold font-mono">{balanceUSDC || '0.00'}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center text-white font-bold">
                  T
                </div>
                <span className="font-semibold">USDT</span>
              </div>
              <span className="text-xl font-bold font-mono">{balanceUSDT || '0.00'}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white/90 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-orange-500" />
              <span>Encrypted Tokens</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center text-white font-bold">
                  eU
                </div>
                <span className="font-semibold">eUSDC</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold font-mono">
                  {decryptedBalanceUSDC || (encBalanceUSDC && encBalanceUSDC !== '0' ? 
                    <span className="flex items-center gap-1">
                      <Lock className="w-4 h-4" />
                      <span className="text-sm text-gray-500">{Number(encBalanceUSDC).toExponential(2)}</span>
                    </span> : '0.00')}
                </span>
                {encBalanceUSDC && encBalanceUSDC !== '0' && !decryptedBalanceUSDC && (
                  <Button
                    onClick={handleDecryptUSDC}
                    disabled={isDecryptingUSDC}
                    size="sm"
                    variant="outline"
                  >
                    {isDecryptingUSDC ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center text-white font-bold">
                  eT
                </div>
                <span className="font-semibold">eUSDT</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold font-mono">
                  {decryptedBalanceUSDT || (encBalanceUSDT && encBalanceUSDT !== '0' ? 
                    <span className="flex items-center gap-1">
                      <Lock className="w-4 h-4" />
                      <span className="text-sm text-gray-500">{Number(encBalanceUSDT).toExponential(2)}</span>
                    </span> : '0.00')}
                </span>
                {encBalanceUSDT && encBalanceUSDT !== '0' && !decryptedBalanceUSDT && (
                  <Button
                    onClick={handleDecryptUSDT}
                    disabled={isDecryptingUSDT}
                    size="sm"
                    variant="outline"
                  >
                    {isDecryptingUSDT ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Trading Interface */}
      <Card className="bg-white/90 backdrop-blur-sm border-orange-100">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-gray-900">
            Trading Operations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="deposit" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="deposit" className="text-xs sm:text-sm md:text-base font-medium">Deposit</TabsTrigger>
              <TabsTrigger value="withdraw" className="text-xs sm:text-sm md:text-base font-medium">Withdraw</TabsTrigger>
              <TabsTrigger value="swap" className="text-xs sm:text-sm md:text-base font-medium px-1 sm:px-2">Private Swap</TabsTrigger>
            </TabsList>
            
            <TabsContent value="deposit" className="space-y-5 mt-6 bg-gradient-to-br from-orange-50 to-red-50/30 p-8 rounded-xl">
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">Select Token</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['USDC', 'USDT'] as const).map((token) => (
                    <Button
                      key={token}
                      onClick={() => setDepositCurrency(token)}
                      variant={depositCurrency === token ? "default" : "outline"}
                      className="h-14 text-lg font-medium"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                          token === 'USDC' ? 'bg-blue-500' : 'bg-green-500'
                        }`}>
                          {token[0]}
                        </div>
                        {token}
                      </div>
                    </Button>
                  ))}
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">Amount</label>
                <div className="relative">
                  <Input
                    type="text"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    placeholder="0.00"
                    className="pr-16 text-xl font-mono h-14"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
                    {depositCurrency}
                  </span>
                </div>
                <p className="text-base text-gray-600">
                  Available: {depositCurrency === 'USDC' ? balanceUSDC : balanceUSDT} {depositCurrency}
                </p>
              </div>
              
              <Button
                onClick={handleDeposit}
                disabled={loading || !depositAmount || parseFloat(depositAmount) <= 0}
                className="w-full h-14 text-lg font-medium"
                variant="default"
              >
                {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                Deposit to Hook
              </Button>
            </TabsContent>
            
            <TabsContent value="withdraw" className="space-y-5 mt-6 bg-gradient-to-br from-orange-50 to-red-50/30 p-8 rounded-xl">
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">Select Encrypted Token</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['USDC', 'USDT'] as const).map((token) => (
                    <Button
                      key={token}
                      onClick={() => setWithdrawCurrency(token)}
                      variant={withdrawCurrency === token ? "default" : "outline"}
                      className="h-14 text-lg font-medium"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                          token === 'USDC' ? 'bg-orange-500' : 'bg-orange-600'
                        }`}>
                          e{token[0]}
                        </div>
                        e{token}
                      </div>
                    </Button>
                  ))}
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">Amount</label>
                <div className="relative">
                  <Input
                    type="text"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="0.00"
                    className="pr-16 text-xl font-mono h-14"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
                    {withdrawCurrency}
                  </span>
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">Recipient (Optional)</label>
                <Input
                  type="text"
                  value={withdrawRecipient}
                  onChange={(e) => setWithdrawRecipient(e.target.value)}
                  placeholder="0x..."
                />
              </div>
              
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                <p className="text-sm text-orange-700">
                  ⚠️ Withdrawing will convert encrypted tokens back to regular tokens
                </p>
              </div>
              
              <Button
                onClick={handleWithdraw}
                disabled={loading || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
                className="w-full"
                variant="default"
              >
                {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
                Withdraw from Hook
              </Button>
            </TabsContent>
            
            <TabsContent value="swap" className="space-y-4 sm:space-y-5 mt-4 sm:mt-6 bg-gradient-to-br from-orange-50 to-red-50/30 p-4 sm:p-6 md:p-8 rounded-xl">
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">From (Encrypted)</label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={swapAmount}
                    onChange={(e) => setSwapAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 text-lg font-mono"
                  />
                  <Select value={tokenIn} onValueChange={(value) => setTokenIn(value as 'USDC' | 'USDT')}>
                    <SelectTrigger className="w-40 border-gray-700">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USDC">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                            eU
                          </div>
                          eUSDC
                        </div>
                      </SelectItem>
                      <SelectItem value="USDT">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-orange-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                            eT
                          </div>
                          eUSDT
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="flex justify-center">
                <Button
                  onClick={() => {
                    setTokenIn(tokenOut);
                    setTokenOut(tokenIn);
                  }}
                  variant="ghost"
                  size="icon"
                  className="rounded-full hover:bg-gray-800 border border-gray-700"
                >
                  <ArrowDownUp className="h-4 w-4" />
                </Button>
              </div>
              
              <div className="space-y-2">
                <label className="text-base sm:text-lg font-semibold text-gray-800">To (Encrypted)</label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={swapAmount}
                    readOnly
                    placeholder="0.00"
                    className="flex-1 text-lg font-mono opacity-70"
                  />
                  <Select value={tokenOut} onValueChange={(value) => setTokenOut(value as 'USDC' | 'USDT')}>
                    <SelectTrigger className="w-40 border-gray-700">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USDC">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                            eU
                          </div>
                          eUSDC
                        </div>
                      </SelectItem>
                      <SelectItem value="USDT">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 bg-orange-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                            eT
                          </div>
                          eUSDT
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-700">
                  🔒 Your swap amount is encrypted using FHE
                </p>
              </div>
              
              <Button
                onClick={handleSubmitIntent}
                disabled={isSubmittingSwap || tokenIn === tokenOut || !swapAmount}
                className="w-full"
                variant="default"
              >
                {isSubmittingSwap ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                {isSubmittingSwap ? 'Processing...' : 'Submit Private Swap'}
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Intent History */}
      <Card className="bg-white/90 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-2xl font-bold">
              <Clock className="h-6 w-6" />
              Intent History
            </span>
            <Button
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
              size="sm"
              variant="outline"
            >
              <RefreshCw className={`h-4 w-4 ${isLoadingIntents ? 'animate-spin' : ''}`} />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          {submittedIntents.length === 0 ? (
            <p className="text-center text-gray-600 py-8 text-xl font-medium">
              No pending intents
            </p>
          ) : (
            <div className="space-y-2">
              {submittedIntents.map((intent) => (
                <div key={intent.id} className="flex items-center justify-between p-5 bg-gradient-to-r from-orange-50 to-red-50/30 rounded-lg">
                  <div className="space-y-2">
                    <p className="text-lg font-mono font-medium">
                      {intent.id.slice(0, 10)}...{intent.id.slice(-8)}
                    </p>
                    <div className="flex items-center gap-2 text-lg">
                      <span className="font-semibold text-blue-600">
                        {getTokenSymbol(intent.tokenIn)}
                      </span>
                      <span className="text-gray-500">→</span>
                      <span className="font-semibold text-green-600">
                        {getTokenSymbol(intent.tokenOut)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {intent.amount && (
                      <span className="text-xl font-bold">{intent.amount}</span>
                    )}
                    {intent.status === 'decrypted' && (
                      <Button
                        onClick={() => handleExecuteIntent(intent.id)}
                        className="h-10 px-4 text-base font-medium"
                        variant="default"
                        disabled={executingIntentId === intent.id}
                      >
                        {executingIntentId === intent.id ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          'Execute'
                        )}
                      </Button>
                    )}
                    <span className={`px-3 py-2 rounded-lg text-sm font-semibold ${
                      intent.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                      intent.status === 'decrypted' ? 'bg-blue-100 text-blue-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {intent.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Faucet */}
      <Card className="bg-white/90 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">
            Test Token Faucet
          </CardTitle>
          <CardDescription className="text-base">Get test tokens for demo (Max 100 tokens, 1 hour cooldown)</CardDescription>
        </CardHeader>
        <CardContent className="p-6">
          <div className="space-y-4 sm:space-y-5 bg-gradient-to-br from-orange-50 to-red-50/30 p-4 sm:p-6 rounded-lg">
          <div className="space-y-2">
            <label className="text-base sm:text-lg font-semibold text-gray-800">Select Token</label>
            <div className="grid grid-cols-2 gap-2">
              {(['USDC', 'USDT'] as const).map((token) => (
                <Button
                  key={token}
                  onClick={() => setFaucetCurrency(token)}
                  variant={faucetCurrency === token ? "default" : "outline"}
                  className="h-12"
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                      token === 'USDC' ? 'bg-blue-500' : 'bg-green-500'
                    }`}>
                      {token[0]}
                    </div>
                    {token}
                  </div>
                </Button>
              ))}
            </div>
          </div>
          
          <div className="space-y-2">
            <label className="text-base sm:text-lg font-semibold text-gray-800">Amount (max 100)</label>
            <div className="relative">
              <Input
                type="number"
                value={faucetAmount}
                onChange={(e) => {
                  const value = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                  setFaucetAmount(value.toString());
                }}
                placeholder="0"
                className="pr-16 text-lg font-mono"
                max="100"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {faucetCurrency}
              </span>
            </div>
            <p className="text-base text-gray-600">
              {parseInt(faucetAmount) > 100 ? 
                <span className="text-orange-600">Maximum 100 tokens per request</span> : 
                `Mint up to 100 test ${faucetCurrency} tokens`
              }
            </p>
          </div>
          
          <Button
            onClick={async () => {
              try {
                const now = Date.now();
                const lastTime = lastFaucetTime[faucetCurrency] || 0;
                const timeDiff = now - lastTime;
                const oneHour = 60 * 60 * 1000;
                
                if (timeDiff < oneHour) {
                  const remainingMinutes = Math.ceil((oneHour - timeDiff) / 60000);
                  toast.error(`Please wait ${remainingMinutes} minutes before requesting ${faucetCurrency} again`);
                  return;
                }
                
                const txHash = await mintTokens(faucetCurrency, faucetAmount);
                setLastFaucetTime({ ...lastFaucetTime, [faucetCurrency]: now });
                if (txHash) {
                  toast.success(
                    <div>
                      Minted {faucetAmount} {faucetCurrency}!
                      <a 
                        href={`https://sepolia.etherscan.io/tx/${txHash}`} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="block text-xs text-blue-600 hover:underline mt-1"
                      >
                        View transaction →
                      </a>
                    </div>
                  );
                } else {
                  toast.success(`Minted ${faucetAmount} ${faucetCurrency}`);
                }
              } catch (err: any) {
                toast.error(err.message || 'Mint failed');
              }
            }}
            disabled={loading || !faucetAmount || parseInt(faucetAmount) > 100}
            className="w-full h-14 text-lg font-medium"
            variant="default"
          >
            {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
            Mint {faucetAmount || '0'} Test Tokens
          </Button>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}