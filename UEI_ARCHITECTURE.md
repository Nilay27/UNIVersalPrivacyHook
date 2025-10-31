# 🎯 UEI (Universal Encrypted Intent) Architecture

## Overview

This document provides a complete technical specification for the Universal Encrypted Intent (UEI) system. UEI enables users to submit encrypted trade intents to DeFi protocols (Aave, Compound, etc.) where the trade destination, amounts, and parameters remain completely private until execution by authorized AVS operators.

---

## 🔑 Core Design Principles

### 1. **Everything as euint256**
All function arguments (addresses, amounts, bools) are encrypted as `euint256` to avoid dynamic type casting in Solidity.

### 2. **SwapManager as Entry Point**
Users submit trades directly to SwapManager (not Hook) to keep UniversalPrivacyHook under the 24KB size limit.

### 3. **Operator Decoder Config**
Off-chain decoder configurations tell operators how to interpret encrypted uint256 values based on the target protocol and function selector.

### 4. **BoringVault Execution**
Assume BoringVault is pre-funded for MVP. Future: integrate with Hook's `beforeAddLiquidity` to route 90% liquidity to vault.

### 5. **Batch Aggregation**
Similar trades (same decoder + target + selector) are batched together to reduce gas costs and improve efficiency.

---

## 📊 Complete Flow Diagram

```
User Wallet
    │
    ├─→ Encrypt trade:
    │   • decoder: address (sanitizer contract)
    │   • target: address (Aave, Compound, etc.)
    │   • selector: bytes4 (function selector)
    │   • args: uint256[] (ALL args as uint256)
    │
    ├─→ createEncryptedInput(SWAP_MANAGER, userAddress)
    │   Returns: handles[] + inputProof
    │
    ▼
SwapManager.submitEncryptedTrade(handles, inputProof, deadline)
    │ msg.sender = User ✓
    │
    ├─→ FHE.fromExternal() for all components
    │   • eaddress decoder
    │   • eaddress target
    │   • euint32 selector
    │   • euint256[] args
    │
    ├─→ Store as TradeTask with internal euints
    ├─→ Add to current batch (5 block interval)
    └─→ emit TradeSubmitted(tradeId, user, batchId)
    │
    ▼
SwapManager (after 5 blocks)
    │
    ├─→ finalizeTradeBatch(batchId)
    ├─→ Select operators deterministically
    ├─→ Grant FHE.allow() permissions to operators
    └─→ emit TradeBatchFinalized(batchId, tradeIds[], operators[])
    │
    ▼
Operator (off-chain monitoring)
    │
    ├─→ Listen for TradeBatchFinalized events
    ├─→ Fetch trade tasks from storage
    ├─→ Batch decrypt all handles:
    │   • decoderHandle → address
    │   • targetHandle → address
    │   • selectorHandle → bytes4
    │   • argHandles[] → uint256[]
    │
    ├─→ Group by (decoder + target + selector)
    │   Example:
    │   User A: Aave.supply(USDT, 500, ...)
    │   User B: Aave.supply(USDT, 700, ...)
    │   → Batch: Aave.supply(USDT, 1200, ...)
    │
    ├─→ Use decoder config to interpret args:
    │   argTypes: ['address', 'uint256', 'address', 'uint16']
    │   arg[0] → address (asset)
    │   arg[1] → uint256 (amount) ← AGGREGATE
    │   arg[2] → address (onBehalfOf)
    │   arg[3] → uint16 (referralCode)
    │
    └─→ Construct batched calldata
    │
    ▼
SwapManager.processTradeBatch(
    batchId,
    decoder,
    target,
    batchedCalldata,
    individualAmounts[],
    operatorSignatures[]
)
    │
    ├─→ Verify operator consensus (signatures)
    ├─→ Execute via BoringVault:
    │   BoringVault.execute(target, batchedCalldata, 0)
    │   → Aave.supply(USDT, 1200) returns 1200 aUSDT
    │
    ├─→ Mark batch as executed
    └─→ emit TradeBatchExecuted(batchId, target, totalAmount, result)
    │
    ▼
Future: Result Distribution
    │
    └─→ Encrypt individual results
    └─→ Distribute to users via Hook
```

---

## 🔐 FHE Encryption Pattern

### Rule for createEncryptedInput

```typescript
createEncryptedInput(contractAddress, userAddress)
```

Where:
- `contractAddress` = Who will call `FHE.fromExternal()`
- `userAddress` = Who will be `msg.sender` when `fromExternal()` is called

### For UEI

```typescript
// User → SwapManager
createEncryptedInput(
    SWAP_MANAGER_ADDRESS,  // SwapManager calls fromExternal()
    userAddress            // User is msg.sender
)
```

**Why?** Because user directly calls `SwapManager.submitEncryptedTrade()`, so `msg.sender = user` and SwapManager calls `FHE.fromExternal()`.

---

## 💻 Smart Contract Implementation

### Data Structures

```solidity
// In SwapManager.sol

struct TradeTask {
    bytes32 tradeId;             // Unique ID
    address submitter;           // User who submitted

    // Encrypted components (internal euints after fromExternal)
    eaddress encDecoder;         // Decoder/sanitizer contract
    eaddress encTarget;          // Target protocol (Aave, Compound, etc.)
    euint32 encSelector;         // Function selector
    euint256[] encArgs;          // ALL arguments as euint256

    // Metadata
    uint256 deadline;            // Expiration timestamp
    bytes32 batchId;             // Which batch this belongs to
    bool processed;              // Execution status
}

struct TradeBatch {
    bytes32[] tradeIds;          // Trade IDs in this batch
    uint256 createdBlock;        // Block when batch created
    uint256 finalizedBlock;      // Block when finalized
    bool finalized;              // Whether finalized
    bool executed;               // Whether executed
    address[] selectedOperators; // Operators for this batch
}

// Constants
uint256 public constant TRADE_BATCH_INTERVAL = 5; // 5 blocks

// State
mapping(bytes32 => TradeBatch) public tradeBatches;
mapping(bytes32 => TradeTask) public tradeTasks;
mapping(bytes32 => bytes32) public currentTradeBatchId;
```

### Key Functions

#### 1. submitEncryptedTrade

```solidity
function submitEncryptedTrade(
    bytes calldata encryptedBlob,   // Encoded handles
    bytes calldata inputProof,       // FHE proof
    uint256 deadline                 // Expiration
) external returns (bytes32 tradeId) {
    // Decode handles
    (
        bytes32 encDecoderHandle,
        bytes32 encTargetHandle,
        bytes32 encSelectorHandle,
        bytes32[] memory encArgHandles
    ) = abi.decode(encryptedBlob, (bytes32, bytes32, bytes32, bytes32[]));

    // Convert external → internal (msg.sender = User)
    eaddress decoder = FHE.fromExternal(
        externalEaddress.wrap(encDecoderHandle),
        inputProof
    );
    FHE.allowThis(decoder);

    eaddress target = FHE.fromExternal(
        externalEaddress.wrap(encTargetHandle),
        inputProof
    );
    FHE.allowThis(target);

    euint32 selector = FHE.fromExternal(
        externalEuint32.wrap(encSelectorHandle),
        inputProof
    );
    FHE.allowThis(selector);

    // Convert ALL args as euint256
    euint256[] memory args = new euint256[](encArgHandles.length);
    for (uint i = 0; i < encArgHandles.length; i++) {
        args[i] = FHE.fromExternal(
            externalEuint256.wrap(encArgHandles[i]),
            inputProof
        );
        FHE.allowThis(args[i]);
    }

    // Get or create batch (5 block interval)
    bytes32 batchId = _getOrCreateBatch();

    // Store trade
    tradeId = keccak256(abi.encode(msg.sender, block.timestamp, encryptedBlob));
    tradeTasks[tradeId] = TradeTask({
        tradeId: tradeId,
        submitter: msg.sender,
        encDecoder: decoder,
        encTarget: target,
        encSelector: selector,
        encArgs: args,
        deadline: deadline,
        batchId: batchId,
        processed: false
    });

    // Add to batch
    tradeBatches[batchId].tradeIds.push(tradeId);

    emit TradeSubmitted(tradeId, msg.sender, batchId, deadline);
}
```

#### 2. finalizeTradeBatch

```solidity
function _finalizeTradeBatch(bytes32 batchId) internal {
    TradeBatch storage batch = tradeBatches[batchId];

    // Select operators
    address[] memory selectedOps = _selectOperatorsForBatch(batchId);
    batch.selectedOperators = selectedOps;

    // Grant FHE permissions to operators
    for (uint i = 0; i < batch.tradeIds.length; i++) {
        TradeTask storage trade = tradeTasks[batch.tradeIds[i]];

        for (uint j = 0; j < selectedOps.length; j++) {
            address operator = selectedOps[j];

            FHE.allow(trade.encDecoder, operator);
            FHE.allow(trade.encTarget, operator);
            FHE.allow(trade.encSelector, operator);

            for (uint k = 0; k < trade.encArgs.length; k++) {
                FHE.allow(trade.encArgs[k], operator);
            }
        }
    }

    batch.finalized = true;
    batch.finalizedBlock = block.number;
    currentTradeBatchId[bytes32(0)] = bytes32(0);

    emit TradeBatchFinalized(batchId, batch.tradeIds, selectedOps, block.number);
}
```

#### 3. processTradeBatch

```solidity
function processTradeBatch(
    bytes32 batchId,
    address decodedDecoder,
    address decodedTarget,
    bytes calldata batchedCalldata,
    uint128[] calldata individualAmounts,
    bytes[] calldata operatorSignatures
) external onlyOperator {
    TradeBatch storage batch = tradeBatches[batchId];
    require(batch.finalized, "Batch not finalized");
    require(!batch.executed, "Already executed");

    // Verify consensus
    _verifyOperatorConsensus(batchId, decodedDecoder, decodedTarget, batchedCalldata, operatorSignatures);

    // Execute via BoringVault (assumed pre-funded)
    bytes memory result = SimpleBoringVault(boringVault).execute(
        decodedTarget,
        batchedCalldata,
        0
    );

    // Mark as executed
    batch.executed = true;
    for (uint i = 0; i < batch.tradeIds.length; i++) {
        tradeTasks[batch.tradeIds[i]].processed = true;
    }

    emit TradeBatchExecuted(batchId, decodedTarget, totalAmount, result);
}
```

---

## 🤖 Operator Implementation

### Decoder Configuration

```typescript
// operator/decoderConfig.ts

interface FunctionConfig {
    selector: string;
    name: string;
    argTypes: string[];  // How to interpret euint256 args
    abi: string[];       // For encoding final calldata
}

interface DecoderConfig {
    decoderAddress: string;
    targetProtocol: string;
    functions: Map<string, FunctionConfig>;
}

// Example: Aave Decoder
const AAVE_CONFIG: DecoderConfig = {
    decoderAddress: '0xAaveDecoder...',
    targetProtocol: 'Aave V3',
    functions: new Map([
        ['0x617ba037', {
            selector: '0x617ba037',
            name: 'supply',
            argTypes: ['address', 'uint256', 'address', 'uint16'],
            abi: ['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']
        }]
    ])
};

const DECODER_REGISTRY = new Map([
    [AAVE_CONFIG.decoderAddress, AAVE_CONFIG]
]);
```

### Batch Decryption

```typescript
// operator/fhevmUtils.ts

export async function batchDecryptHandles(
    handles: any[],
    contractAddress: string
): Promise<bigint[]> {
    // Convert handles to string format
    const handleStrings = handles.map(h => {
        if (typeof h === 'string') return h;
        if (typeof h === 'bigint') return '0x' + h.toString(16).padStart(64, '0');
        if (h._isBigNumber) return h.toHexString();
        return h.toString();
    });

    // Batch decrypt
    const decryptRequests = handleStrings.map(handle => ({
        handle: handle,
        contractAddress: contractAddress
    }));

    const decryptedResults = await fhevmInstance.decrypt(
        decryptRequests,
        operatorKeypair.privateKey
    );

    // Extract values
    const values: bigint[] = [];
    for (const handle of handleStrings) {
        values.push(BigInt(decryptedResults[handle]));
    }

    return values;
}
```

### Trade Processing

```typescript
// operator/tradeProcessor.ts

async function processTradeBatch(
    swapManager: ethers.Contract,
    wallet: ethers.Wallet,
    batchId: string,
    tradeIds: string[]
) {
    // 1. Fetch trades and collect handles
    const trades: any[] = [];
    const handlesToDecode: string[] = [];

    for (const tradeId of tradeIds) {
        const trade = await swapManager.tradeTasks(tradeId);

        trades.push({
            tradeId,
            submitter: trade.submitter,
            decoderHandle: trade.encDecoder,
            targetHandle: trade.encTarget,
            selectorHandle: trade.encSelector,
            argHandles: trade.encArgs,
            batchId: trade.batchId
        });

        // Collect all handles
        handlesToDecode.push(trade.encDecoder);
        handlesToDecode.push(trade.encTarget);
        handlesToDecode.push(trade.encSelector);
        trade.encArgs.forEach((h: any) => handlesToDecode.push(h));
    }

    // 2. Batch decrypt ALL handles
    const decryptedValues = await batchDecryptHandles(
        handlesToDecode,
        await swapManager.getAddress()
    );

    // 3. Map values back to trades
    let offset = 0;
    const decryptedTrades = [];

    for (const trade of trades) {
        const decoder = `0x${decryptedValues[offset++].toString(16).padStart(40, '0')}`;
        const target = `0x${decryptedValues[offset++].toString(16).padStart(40, '0')}`;
        const selector = `0x${decryptedValues[offset++].toString(16).padStart(8, '0')}`;

        const args: bigint[] = [];
        for (let i = 0; i < trade.argHandles.length; i++) {
            args.push(decryptedValues[offset++]);
        }

        decryptedTrades.push({ tradeId: trade.tradeId, submitter: trade.submitter, decoder, target, selector, args });
    }

    // 4. Batch similar trades
    const batches = batchSimilarTrades(decryptedTrades);

    // 5. Execute each batch
    for (const [key, batchedTrades] of batches) {
        await executeBatchedTrades(swapManager, wallet, batchId, batchedTrades);
    }
}
```

### Batching & Execution

```typescript
function batchSimilarTrades(trades: DecryptedTrade[]): Map<string, DecryptedTrade[]> {
    const batches = new Map();

    for (const trade of trades) {
        // Batch key: decoder + target + selector
        const key = `${trade.decoder}-${trade.target}-${trade.selector}`;

        if (!batches.has(key)) {
            batches.set(key, []);
        }
        batches.get(key)!.push(trade);
    }

    return batches;
}

async function executeBatchedTrades(
    swapManager: ethers.Contract,
    wallet: ethers.Wallet,
    batchId: string,
    trades: DecryptedTrade[]
) {
    // Get decoder config
    const decoderConfig = DECODER_REGISTRY.get(trades[0].decoder);
    const functionConfig = decoderConfig.functions.get(trades[0].selector);

    // Find amount index in argTypes
    const amountIndex = functionConfig.argTypes.findIndex(
        type => type.includes('uint') && !type.includes('uint16')
    );

    // Aggregate amounts
    const totalAmount = trades.reduce((sum, t) => sum + t.args[amountIndex], 0n);
    const individualAmounts = trades.map(t => t.args[amountIndex]);

    // Construct batched calldata
    const batchedArgs = parseArguments(trades[0].args, functionConfig.argTypes);
    batchedArgs[amountIndex] = totalAmount;

    const iface = new ethers.Interface(functionConfig.abi);
    const batchedCalldata = iface.encodeFunctionData(functionConfig.name, batchedArgs);

    // Sign and submit
    const messageHash = ethers.solidityPackedKeccak256(
        ['bytes32', 'address', 'address', 'bytes'],
        [batchId, trades[0].decoder, trades[0].target, batchedCalldata]
    );
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    const tx = await swapManager.processTradeBatch(
        batchId,
        trades[0].decoder,
        trades[0].target,
        batchedCalldata,
        individualAmounts,
        [signature],
        { gasLimit: 5000000 }
    );

    await tx.wait();
}

function parseArguments(args: bigint[], argTypes: string[]): any[] {
    return args.map((arg, i) => {
        const type = argTypes[i];
        if (type === 'address') {
            return ethers.getAddress('0x' + arg.toString(16).padStart(40, '0'));
        } else if (type === 'bool') {
            return arg !== 0n;
        } else {
            return arg;
        }
    });
}
```

---

## 📝 Client-Side Submission

```typescript
// frontend/submitTrade.ts

import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk';
import { ethers } from 'ethers';

async function submitAaveSupply(
    swapManager: ethers.Contract,
    signer: ethers.Signer,
    assetAddress: string,
    amount: bigint,
    onBehalfOf: string
) {
    // 1. Initialize FHEVM
    const fhevmInstance = await createInstance({
        ...SepoliaConfig,
        network: RPC_URL
    });

    // 2. Prepare trade details
    const decoderAddress = AAVE_DECODER_ADDRESS;
    const targetAddress = AAVE_POOL_ADDRESS;
    const functionSelector = 0x617ba037; // supply(address,uint256,address,uint16)

    // 3. Encrypt all components
    const userAddress = await signer.getAddress();

    const encryptedInput = fhevmInstance.createEncryptedInput(
        await swapManager.getAddress(),  // SwapManager calls fromExternal
        userAddress                       // User is msg.sender
    );

    // Add encrypted data
    encryptedInput.addAddress(decoderAddress);
    encryptedInput.addAddress(targetAddress);
    encryptedInput.add32(functionSelector);

    // Add all args as uint256
    encryptedInput.add256(BigInt(assetAddress));  // asset
    encryptedInput.add256(amount);                 // amount
    encryptedInput.add256(BigInt(onBehalfOf));    // onBehalfOf
    encryptedInput.add256(0n);                     // referralCode

    const encrypted = await encryptedInput.encrypt();

    // 4. Submit to SwapManager
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    const tx = await swapManager.submitEncryptedTrade(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32', 'bytes32', 'bytes32[]'],
            [
                encrypted.handles[0],           // decoder
                encrypted.handles[1],           // target
                encrypted.handles[2],           // selector
                encrypted.handles.slice(3)      // args[]
            ]
        ),
        encrypted.inputProof,
        deadline
    );

    const receipt = await tx.wait();
    console.log('Trade submitted:', receipt.hash);
}
```

---

## 🎯 Key Insights

### ✅ Why Everything as euint256 Works

1. **No Dynamic Typing**: Solidity can't handle dynamic type casting
2. **Operator Intelligence**: Decoder config interprets values off-chain
3. **Flexible**: Supports any function with any argument types
4. **Batchable**: Same (decoder + target + selector) = batchable

### ✅ Handle Decryption

- **On-chain**: Handles are stored as `eaddress`, `euint32`, `euint256`
- **TypeScript**: Storage reads return handles as `BigNumber`/`string`
- **No unwrap()**: TypeScript doesn't have `euint.unwrap()`
- **SDK agnostic**: `decrypt()` doesn't care about type - all handles are bytes32

### ✅ Batching Benefits

```
Example Batch:
User A: Aave.supply(USDT, 500, vault, 0)
User B: Aave.supply(USDT, 700, vault, 0)

Batched Execution:
Aave.supply(USDT, 1200, vault, 0)

Savings:
- 1 transaction instead of 2
- ~50% gas reduction
- Same output: 1200 aUSDT distributed proportionally
```

---

## 🚀 Future Enhancements

1. **Result Distribution**: Encrypt execution results and distribute via Hook
2. **Merkle Tree Verification**: On-chain proof of allowed protocols
3. **Hook Integration**: Auto-fund BoringVault via `beforeAddLiquidity` (90% routing)
4. **Multi-Protocol Support**: Add more decoder configs (Yearn, Curve, etc.)
5. **Partial Fills**: Support for large orders split across batches

---

## 📊 Testing Strategy

### MVP Testing Checklist

- [ ] User encrypts Aave supply trade
- [ ] SwapManager receives and stores encrypted trade
- [ ] Batch finalization after 5 blocks
- [ ] Operator decrypts all components
- [ ] Operator batches similar trades
- [ ] Execution via BoringVault succeeds
- [ ] Event emissions are correct

### Debug Points

1. **Encryption**: Verify handles are generated correctly
2. **Storage**: Check trade tasks are stored with correct types
3. **Permissions**: Ensure operators can decrypt
4. **Decryption**: Verify all handles decrypt to expected values
5. **Batching**: Check similar trades are grouped correctly
6. **Execution**: Verify calldata construction is correct
7. **Consensus**: Check signature verification works

---

*Generated on 2025-01-XX | Version 1.0 | For UniversalPrivacyHook MVP*
