"use client";

import { useMetaMaskEthersSigner } from '../hooks/metamask/useMetaMaskEthersSigner';
import { useState, useEffect } from 'react';
import { Wallet } from 'lucide-react';

export function NavBar() {
  const { ethersSigner: signer } = useMetaMaskEthersSigner();
  const [walletAddress, setWalletAddress] = useState<string>('');

  useEffect(() => {
    if (signer) {
      signer.getAddress().then(setWalletAddress).catch(console.error);
    } else {
      setWalletAddress('');
    }
  }, [signer]);

  return (
    <div className="flex items-center justify-between w-full">
      {/* Logo and Brand */}
      <div className="flex items-center space-x-2 sm:space-x-3">
        <img src="/Logo-vector.png" alt="Logo" className="w-10 h-10 sm:w-14 sm:h-14 md:w-20 md:h-20" />
        <div className="flex flex-col">
          <span className="text-base sm:text-xl md:text-2xl font-semibold text-gray-900">
            <span className="hidden sm:inline">UNIversal Privacy Hook</span>
            <span className="sm:hidden">UNIversalPrivacy Hook</span>
          </span>
          <span className="hidden sm:block text-xs text-gray-500">Powered by ZAMA FHE on Uniswap V4</span>
        </div>
      </div>
      
      {/* Right side - Wallet and Network */}
      <div className="flex items-center space-x-1 sm:space-x-3">
        {walletAddress && (
          <div className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-4 py-1 sm:py-2 bg-gray-100 rounded-md">
            <Wallet className="h-3 w-3 sm:h-4 sm:w-4 text-orange-500" />
            <span className="text-xs sm:text-sm font-mono text-gray-700">
              <span className="hidden sm:inline">{walletAddress.substring(0, 6)}...{walletAddress.substring(38)}</span>
              <span className="sm:hidden">{walletAddress.substring(0, 4)}...{walletAddress.substring(40)}</span>
            </span>
          </div>
        )}
        <div className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-gray-100 rounded-md">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-xs sm:text-sm font-medium text-gray-700">Sepolia</span>
        </div>
      </div>
    </div>
  );
}