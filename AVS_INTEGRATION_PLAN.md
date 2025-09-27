# AVS Integration Plan for UniversalPrivacyHook with ZAMA FHEVM

## Overview
Transform the UniversalPrivacyHook from callback-based FHE decryption to AVS-based batch processing with ZAMA FHEVM. The system will batch encrypted swap intents, forward them to AVS operators for decryption and internal matching, then submit only net swaps on-chain to preserve privacy.

## Architecture Flow
```
1. User submits encrypted swap intent → Hook
2. Hook accumulates intents for 5 blocks → Batch formation
3. Hook selects AVS operators and grants FHE decryption permissions
4. Hook emits batch event → AVS SwapManager with operator list
5. AVS operators decrypt intents off-chain using granted permissions
6. Operators perform internal matching
7. Consensus on net swaps → Settlement on-chain
8. Hook updates user balances with results
9. Hook revokes operator permissions (if supported)
```

## Critical: AVS Operator Decryption Access

### ZAMA FHE Permission Model
In ZAMA's FHEVM, encrypted values are protected by access control. For AVS operators to decrypt intents:

1. **Permission Granting**: The contract must explicitly call `FHE.allow(encryptedValue, operatorAddress)` for each operator
2. **Batch Processing**: All intents in a batch need permissions granted to selected operators
3. **Operator Selection**: AVS SwapManager selects committee of operators (e.g., 5 operators)
4. **Decryption Process**: Operators use their granted permissions to decrypt via FHE Gateway
5. **Security**: Only authorized operators can decrypt, maintaining privacy from others

### Implementation Flow
```solidity
// When batch is finalized:
1. SwapManager.selectOperatorsForBatch() → returns operator addresses
2. Hook grants FHE.allow() for each intent to each operator
3. Hook sends batch with operator list to SwapManager
4. Operators decrypt using their permissions
5. After settlement, permissions ideally revoked (check ZAMA support)
```

## Implementation Tasks

### Phase 1: Hook Contract Adaptation
#### 1.1 Remove Callback Pattern
- [ ] Remove `finalizeIntent` callback function
- [ ] Remove `requestToIntentId` mapping
- [ ] Remove FHE.requestDecryption calls
- [ ] Remove `decrypted` and `decryptedAmount` fields from Intent struct

#### 1.2 Add AVS Integration
- [ ] Add `ISwapManager` interface import
- [ ] Add `swapManager` state variable for AVS contract reference
- [ ] Add batch management structures:
  - `currentBatchId` per pool
  - `batchIntentIds` mapping (batchId => intentIds[])
  - `batchCreatedBlock` tracking
  - `BATCH_INTERVAL` constant (5 blocks)

#### 1.3 Batch Formation Logic
- [ ] Modify `submitIntent` to add intents to current batch
- [ ] Add `_checkAndFinalizeBatch` function:
  - Check if 5 blocks have passed since batch creation
  - If yes, emit batch to AVS and start new batch
- [ ] Add `finalizeBatch` function (callable by anyone):
  - Packages batch data
  - Calls `swapManager.createBatch()`
  - Emits `BatchCreated` event

### Phase 2: AVS Integration Points
#### 2.1 Batch Submission to AVS
- [ ] Create `_submitBatchToAVS` function:
  ```solidity
  function _submitBatchToAVS(bytes32 batchId, address[] memory operators) internal {
      Batch storage batch = batches[batchId];
      bytes[] memory encryptedIntents = new bytes[](batch.intentIds.length);

      for (uint i = 0; i < batch.intentIds.length; i++) {
          Intent storage intent = intents[batch.intentIds[i]];

          // Package encrypted intent data with handle for operators to decrypt
          encryptedIntents[i] = abi.encode(
              euint128.unwrap(intent.encAmount),  // The encrypted handle that operators can decrypt
              intent.tokenIn,
              intent.tokenOut,
              intent.owner
          );
      }

      // Submit to AVS with selected operators who have decryption permissions
      ISwapManager(swapManager).createBatch(
          batchId,
          address(this),
          batch.poolId,
          encryptedIntents,
          operators  // Pass operators who were granted access
      );

      emit BatchSubmittedToAVS(batchId, operators.length, batch.intentIds.length);
  }
  ```

#### 2.2 Settlement Reception from AVS
- [ ] Add `settleBatch` function (callable only by SwapManager):
  ```solidity
  function settleBatch(
      bytes32 batchId,
      NetSwap[] calldata netSwaps,
      InternalTransfer[] calldata transfers
  ) external onlySwapManager {
      // Execute net swaps on Uniswap
      // Update encrypted balances for internal transfers
      // Mark intents as processed
  }
  ```

### Phase 3: ZAMA FHEVM Specific Changes
#### 3.1 Import Updates
- [ ] Change from Fhenix imports to ZAMA:
  ```solidity
  import {FHE, externalEuint128, euint128} from "@fhevm/solidity/lib/FHE.sol";
  import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
  ```

#### 3.2 Encryption/Decryption Pattern
- [ ] Update `deposit` to use ZAMA's encryption:
  ```solidity
  euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
  FHE.allowThis(encryptedAmount);
  FHE.allow(encryptedAmount, address(encryptedToken));
  ```

#### 3.3 Access Control for AVS Operator Decryption (CRITICAL)
- [ ] Add batch-level operator access granting:
  ```solidity
  // Called when batch is finalized and sent to AVS
  function grantBatchOperatorAccess(
      bytes32 batchId,
      address[] calldata operators
  ) external onlySwapManager {
      Batch storage batch = batches[batchId];

      // Grant each selected operator access to all intents in the batch
      for (uint i = 0; i < batch.intentIds.length; i++) {
          Intent storage intent = intents[batch.intentIds[i]];

          // Grant FHE access to each operator for this encrypted amount
          for (uint j = 0; j < operators.length; j++) {
              FHE.allow(intent.encAmount, operators[j]);
          }

          // Store operators for this intent
          intent.selectedOperators = operators;
      }

      emit OperatorsGrantedAccess(batchId, operators);
  }
  ```

- [ ] Update batch finalization to include operator selection:
  ```solidity
  function finalizeBatch(PoolId poolId) external {
      bytes32 batchId = currentBatchId[poolId];
      require(block.number >= batchCreatedBlock[poolId] + BATCH_INTERVAL, "Batch not ready");

      // Get selected operators from AVS
      address[] memory selectedOperators = ISwapManager(swapManager).selectOperatorsForBatch(batchId);

      // Grant operators access to decrypt all intents in batch
      _grantBatchOperatorAccess(batchId, selectedOperators);

      // Submit batch to AVS
      _submitBatchToAVS(batchId, selectedOperators);

      // Start new batch
      _startNewBatch(poolId);
  }
  ```

- [ ] Add operator permission revocation after settlement:
  ```solidity
  function revokeOperatorAccess(bytes32 batchId) internal {
      Batch storage batch = batches[batchId];

      for (uint i = 0; i < batch.intentIds.length; i++) {
          Intent storage intent = intents[batch.intentIds[i]];

          // Revoke access for all operators (if ZAMA supports revocation)
          for (uint j = 0; j < intent.selectedOperators.length; j++) {
              // Note: Check if ZAMA FHE supports revoking permissions
              // If not, ensure intents are marked as processed to prevent reuse
          }
      }
  }
  ```

### Phase 4: Settlement Logic
#### 4.1 Net Swap Execution
- [ ] Implement `_executeNetSwap`:
  - Use pool manager unlock pattern
  - Settle only net amounts
  - Update pool reserves

#### 4.2 Internal Transfer Processing
- [ ] Implement `_processInternalTransfers`:
  - Update encrypted balances without on-chain swaps
  - Emit events for transparency

### Phase 5: Testing & Deployment
#### 5.1 Contract Testing
- [ ] Unit tests for batch formation
- [ ] Integration tests with mock AVS
- [ ] Test encrypted amount handling

#### 5.2 AVS Integration Testing
- [ ] Deploy SwapManager on testnet
- [ ] Register test operators
- [ ] End-to-end batch processing test

#### 5.3 Frontend Integration
- [ ] Update frontend to handle batch status
- [ ] Add batch tracking UI
- [ ] Show settlement progress

## Key Contract Changes

### Remove from UniversalPrivacyHook.sol:
```solidity
// Remove these:
- mapping(uint256 => bytes32) private requestToIntentId;
- function finalizeIntent(uint256 requestId, uint128 decryptedAmount, bytes[] memory signatures)
- function executeIntent(bytes32 intentId)
- intent.decrypted field
- intent.decryptedAmount field
```

### Add to UniversalPrivacyHook.sol:
```solidity
// Add these:
+ ISwapManager public swapManager;
+ uint256 public constant BATCH_INTERVAL = 5; // blocks
+ mapping(PoolId => bytes32) public currentBatchId;
+ mapping(PoolId => uint256) public batchCreatedBlock;
+
+ modifier onlySwapManager() {
+     require(msg.sender == address(swapManager), "Only SwapManager");
+     _;
+ }
+
+ function finalizeBatch(PoolId poolId) external
+ function settleBatch(bytes32 batchId, NetSwap[] calldata netSwaps, InternalTransfer[] calldata transfers) external onlySwapManager
```

## Testing Checklist
1. [ ] Deploy contracts on Sepolia testnet
2. [ ] Register AVS operators
3. [ ] Submit test encrypted intents
4. [ ] Wait for batch formation (5 blocks)
5. [ ] Verify AVS receives batch
6. [ ] Confirm operator decryption
7. [ ] Check settlement transaction
8. [ ] Verify user balance updates
9. [ ] Test withdrawal functionality

## Environment Setup
```bash
# Deploy order:
1. Deploy SwapManager (AVS)
2. Deploy UniversalPrivacyHook with SwapManager address
3. Deploy HybridFHERC20 tokens
4. Register operators with AVS
5. Authorize hook in SwapManager
```

## Success Criteria
- ✅ Batches form automatically after 5 blocks
- ✅ AVS operators successfully decrypt intents
- ✅ Internal matching reduces on-chain swaps
- ✅ Only net swaps hit the chain
- ✅ Complete privacy preservation
- ✅ End-to-end testnet transaction works

## Next Steps
1. Start with Phase 1.1 - Remove callback pattern
2. Implement AVS integration points
3. Update to ZAMA FHEVM imports
4. Test on local fork first
5. Deploy to Sepolia testnet
6. Run end-to-end test with UI