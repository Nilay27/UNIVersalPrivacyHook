const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function main() {
    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
    
    const chainId = 31337;
    
    // Load deployment addresses
    const swapManagerDeployment = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../contracts/deployments/swap-manager/${chainId}.json`), 'utf8')
    );
    
    const mockHookDeployment = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../contracts/deployments/mock-hook/${chainId}.json`), 'utf8')
    );
    
    // Load SwapManager ABI
    const swapManagerABI = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../abis/SwapManager.json'), 'utf8')
    );
    
    const swapManager = new ethers.Contract(
        swapManagerDeployment.addresses.SwapManager,
        swapManagerABI,
        wallet
    );
    
    const mockHookAddress = mockHookDeployment.addresses.mockPrivacyHook;
    
    console.log('SwapManager address:', swapManagerDeployment.addresses.SwapManager);
    console.log('MockPrivacyHook address:', mockHookAddress);
    
    // Check if already authorized
    const isAuthorized = await swapManager.authorizedHooks(mockHookAddress);
    
    if (isAuthorized) {
        console.log('✅ MockPrivacyHook is already authorized');
    } else {
        console.log('Authorizing MockPrivacyHook...');
        
        try {
            const tx = await swapManager.authorizeHook(mockHookAddress);
            console.log('Transaction sent:', tx.hash);
            await tx.wait();
            console.log('✅ MockPrivacyHook authorized successfully!');
        } catch (error) {
            console.error('Error authorizing hook:', error);
        }
    }
    
    // Verify authorization
    const isNowAuthorized = await swapManager.authorizedHooks(mockHookAddress);
    console.log('Final authorization status:', isNowAuthorized);
}

main().catch(console.error);