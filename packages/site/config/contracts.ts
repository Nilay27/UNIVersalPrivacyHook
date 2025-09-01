// Contract addresses on Sepolia
export const CONTRACTS = {
  UniversalPrivacyHook: "0x2295fc02c9C2e1D24aa7e6547a94dD7396a90080",
  MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
  MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
  EncryptedUSDC: "0xeB0Afa59Dd28744028325Fd825AaF5A10ceC79EF",
  EncryptedUSDT: "0x1C8FE2B040b01ab27BC59635f0d4de57aF8A5A9e",
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
} as const;

export const POOL_CONFIG = {
  FEE: 3000,
  TICK_SPACING: 60,
  POOL_ID: "0xEF50B5D3FB43D3B95C88FD9C386D92631B575036F0044CA74050A78089D42D96",
} as const;

// Helper to build pool key
export function getPoolKey() {
  // Sort currencies (lower address first)
  let currency0 = CONTRACTS.MockUSDC;
  let currency1 = CONTRACTS.MockUSDT;
  if (currency0.toLowerCase() > currency1.toLowerCase()) {
    [currency0, currency1] = [currency1, currency0];
  }
  
  return {
    currency0,
    currency1,
    fee: POOL_CONFIG.FEE,
    tickSpacing: POOL_CONFIG.TICK_SPACING,
    hooks: CONTRACTS.UniversalPrivacyHook,
  };
}