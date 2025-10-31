import 'dotenv/config';
import { ethers } from 'ethers';
import { initializeNexus, deinitializeNexus } from '.';

async function main() {
    const rpcUrl = process.env.RPC_URL;
    const privateKey = process.env.PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
        throw new Error('RPC_URL and PRIVATE_KEY must be set in environment');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: true,
    });
    const wallet = new ethers.Wallet(privateKey, provider);

    const sdk = await initializeNexus(wallet, {
        network: 'testnet',
        debug: true,
    });

    console.log('Nexus SDK initialized successfully with operator wallet:', wallet.address);

    try {
        const balances = await sdk.getUnifiedBalances();
        console.log('Unified balances response:', balances);
    } catch (balanceError) {
        console.error('Failed to fetch unified balances:', balanceError);
    }

    await deinitializeNexus();
}

main().catch((error) => {
    console.error('Nexus SDK initialization failed:', error);
    process.exitCode = 1;
});
