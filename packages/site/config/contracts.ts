// Contract addresses on Sepolia
export const CONTRACTS = {
  UniversalPrivacyHook: "0x90a3Ca02cc80F34A105eFDfDaC8F061F8F770080",
  MockUSDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
  MockUSDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
  EncryptedUSDC: "0x8764A2f9D8ba603800227f860c181e10Be16e3d8",
  EncryptedUSDT: "0xf4e0Ba0028215aB6795d515Ed209997dC676000d",
  PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
} as const;

export const POOL_CONFIG = {
  FEE: 3000,
  TICK_SPACING: 60,
  POOL_ID: "0x1706511516D9D7794D66A45EE230280F1B1D1D479311E7AAF38746C339CFA653",
} as const;

// Helper to build pool key
export function getPoolKey() {
  // Sort currencies (lower address first)
  let currency0: string = CONTRACTS.MockUSDC;
  let currency1: string = CONTRACTS.MockUSDT;
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