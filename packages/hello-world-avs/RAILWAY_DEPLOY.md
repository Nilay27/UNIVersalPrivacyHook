# Railway Deployment Guide

## Quick Deploy Steps

### 1. Push to GitHub
```bash
git add .
git commit -m "feat: add Railway deployment config"
git push origin feat/avs-swap-batching
```

### 2. Railway Setup

1. Go to [Railway.app](https://railway.app)
2. Click **"Start a New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose repository: `Nilay27/UNIVersalPrivacyHook`
5. **Important:** Set root directory to `packages/hello-world-avs`

### 3. Configure Environment Variables

Add these in Railway dashboard (Settings → Variables):

```env
PRIVATE_KEY=your_helper_wallet_private_key
RPC_URL=https://rpc.ankr.com/eth_sepolia/YOUR_API_KEY
CHAIN_ID=11155111
HOOK_ADDRESS=0x32841c9E0245C4B1a9cc29137d7E1F078e6f0080
SWAP_MANAGER_ADDRESS=0xFbce8804FfC5413d60093702664ABfd71Ce0E592
```

### 4. Deploy

Railway will automatically:
- Install dependencies
- Build TypeScript
- Start both services:
  - Helper service (monitors & submits counter-intents)
  - Operator service (decrypts & settles batches)

### 5. Monitor Logs

View logs in Railway dashboard to see:
- `🔔 New intent detected...`
- `🤖 Auto-submitting helper counter-intent...`
- `✅ Batch settled!`

## Services Running

1. **Helper Service** (`createEncryptedSwapTasks.ts`)
   - Monitors for user swap intents
   - Submits 1 token counter-intents
   - Triggers batch finalization after 4 blocks

2. **Operator Service** (`index.ts`)
   - Monitors for finalized batches
   - Decrypts amounts using FHE
   - Submits settlements to SwapManager

## Troubleshooting

### Build fails
- Check that `jq` is installed (it's in nixpacks.toml)
- Verify all environment variables are set

### Services don't start
- Check logs for connection errors
- Verify RPC_URL is correct
- Ensure wallet has enough ETH for gas

### No intents detected
- Verify HOOK_ADDRESS matches deployed contract
- Check that helper wallet is different from UI wallet
- Ensure helper wallet has deposited tokens

## Cost

Railway free tier: $5/month credit
- This deployment uses minimal resources
- Should stay within free tier for demo purposes
