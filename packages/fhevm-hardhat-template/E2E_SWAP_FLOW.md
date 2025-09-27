# End-to-End Swap Flow with AVS Integration

## Key Concepts & Types

### 1. Currency Types
- **Currency**: Uniswap V4 pool currencies (e.g., USDC, USDT) - standard ERC20 tokens
- **IFHERC20**: Encrypted token contracts (e.g., eUSDC, eUSDT) - hybrid FHE/ERC20 tokens created by the hook
- **Mapping**: poolEncryptedTokens[poolId][Currency] => IFHERC20 contract address

### 2. Encryption States
- **Encrypted (euint128)**: User balances, intent amounts, internal transfers
- **Unencrypted (uint128)**: Net swap amounts, pool reserves, actual AMM trades

## Complete Flow

### Phase 1: Setup & Deposit
```
1. User has: 12,000 USDC (standard ERC20)
2. User calls: hook.deposit(poolKey, USDC, 12000)
3. Hook actions:
   - Transfers 12,000 USDC from user to hook
   - Creates/gets eUSDC contract (IFHERC20)
   - Mints 12,000 eUSDC to user (encrypted)
   - Updates poolReserves[poolId][USDC] += 12000
4. Result: User has 12,000 eUSDC (encrypted tokens)
```

### Phase 2: Intent Submission
```
1. User wants: Swap 12,000 eUSDC for eUSDT
2. User creates: Encrypted amount (euint128) of 12000
3. User calls: hook.submitIntent(poolKey, USDC, USDT, encAmount, proof, deadline)
4. Hook actions:
   - Validates currency pair (USDC/USDT valid for pool)
   - Transfers 12,000 eUSDC from user to hook (encrypted transfer)
   - Adds intent to current batch
   - Creates new batch if 5 blocks passed
5. Result: Intent stored, eUSDC held by hook as collateral
```

### Phase 3: Batch Finalization
```
1. Anyone calls: hook.finalizeBatch(poolId) after 5 blocks
2. Hook actions:
   - Marks batch as finalized
   - Emits BatchCreated and BatchFinalized events
   - TODO: Calls SwapManager.createBatch() with encrypted intent data
3. AVS receives: Batch of encrypted intents
```

### Phase 4: AVS Processing (Off-chain)
```
1. AVS operators decrypt intents using granted permissions
2. Example batch:
   - U1: 12,000 eUSDC → eUSDT
   - U2: 7,500 eUSDT → eUSDC
   - U3: 4,000 eUSDC → eUSDT
   - U4: 1,200 eUSDT → eUSDC

3. AVS performs internal matching:
   - Match U1 ↔ U2: 7,500 (internal)
   - Match U3 ↔ U4: 1,200 (internal)

4. AVS calculates net swap needed:
   - Remaining U1: 4,500 eUSDC → eUSDT (needs AMM)
   - Remaining U3: 2,800 eUSDC → eUSDT (needs AMM)
   - Total net: 7,300 USDC → USDT (AMM swap)

5. AVS prepares settlement data:
   - Internal transfers (encrypted amounts)
   - Net swap amount (unencrypted)
   - User distributions from AMM output
```

### Phase 5: Settlement Execution
```
1. AVS calls: hook.settleBatch(batchId, internalTransfers, netAmountIn, tokenIn, tokenOut, userSettlements)

2. Internal Transfers Processing:
   InternalTransfer[] = [
     {from: U1, to: U2, token: eUSDC_contract, encAmount: encrypted(7500)},
     {from: U2, to: U1, token: eUSDT_contract, encAmount: encrypted(7500)},
     {from: U3, to: U4, token: eUSDC_contract, encAmount: encrypted(1200)},
     {from: U4, to: U3, token: eUSDT_contract, encAmount: encrypted(1200)}
   ]

   For each transfer:
   - Get IFHERC20 contract (NOT Currency!)
   - Use encAmount directly (already encrypted by AVS)
   - burnEncrypted(from, encAmount)
   - mintEncrypted(to, encAmount)

3. Net Swap Execution:
   - netAmountIn: 7,300 (unencrypted USDC amount)
   - tokenIn: USDC (Currency type for pool)
   - tokenOut: USDT (Currency type for pool)
   - Calls poolManager.unlock() → executes swap on Uniswap V4
   - Updates poolReserves

4. AMM Output Distribution:
   UserSettlement[] = [
     {user: U1, token: eUSDT_contract, amount: 4500, isDebit: true},
     {user: U3, token: eUSDT_contract, amount: 2800, isDebit: true}
   ]

   For each settlement:
   - Get IFHERC20 contract
   - Create encrypted amount from unencrypted settlement
   - mintEncrypted(user, encAmount) if isDebit
   - burnEncrypted(user, encAmount) if !isDebit
```

### Phase 6: Final State
```
User Balances (all encrypted):
- U1: 0 eUSDC, 12,000 eUSDT
- U2: 7,500 eUSDC, 0 eUSDT
- U3: 0 eUSDC, 4,000 eUSDT
- U4: 1,200 eUSDC, 0 eUSDT

Hook Reserves (unencrypted):
- USDC: decreased by 7,300
- USDT: increased by 7,300

On-chain Visibility:
- Only net swap of 7,300 USDC → USDT visible
- Individual trades remain private
```

## Critical Implementation Details

### 1. Type Distinctions
```solidity
// For pool operations (AMM swaps)
Currency tokenIn;  // e.g., USDC address wrapped as Currency
Currency tokenOut; // e.g., USDT address wrapped as Currency

// For encrypted token operations (user balances)
IFHERC20 encToken; // e.g., eUSDC contract
address encTokenAddress; // address of eUSDC contract

// Never mix these up!
```

### 2. Encryption Rules
```solidity
// ENCRYPTED (euint128):
- User balances in IFHERC20
- Intent amounts
- Internal transfer amounts from AVS

// UNENCRYPTED (uint128):
- Net swap amounts for AMM
- Pool reserves
- Settlement distributions (converted to encrypted on-chain)
```

### 3. Contract Interactions
```
UniversalPrivacyHook
├── Holds actual USDC/USDT reserves
├── Creates/manages eUSDC/eUSDT contracts
├── Executes swaps on Uniswap V4
└── Updates encrypted balances

IFHERC20 (eUSDC, eUSDT)
├── Tracks encrypted user balances
├── Supports encrypted transfers
└── Mint/burn controlled by hook

SwapManager (AVS)
├── Receives encrypted intents
├── Coordinates operator decryption
├── Performs internal matching
└── Submits settlement to hook
```

## Common Mistakes to Avoid
1. ❌ Using Currency type for encrypted token operations
2. ❌ Creating new encrypted amounts for internal transfers (AVS already provides them)
3. ❌ Confusing pool tokens (USDC) with encrypted tokens (eUSDC)
4. ❌ Encrypting net swap amounts (they should be plaintext)
5. ❌ Not distinguishing between IFHERC20 addresses and Currency addresses