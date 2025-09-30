import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function cancelPendingTransactions() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    console.log('Checking account:', wallet.address);

    const currentNonce = await provider.getTransactionCount(wallet.address, 'latest');
    const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');

    console.log('Current confirmed nonce:', currentNonce);
    console.log('Pending nonce:', pendingNonce);

    if (pendingNonce > currentNonce) {
        console.log(`Found ${pendingNonce - currentNonce} pending transaction(s)`);
        console.log('Sending cancellation transaction...');

        // Get current gas price and increase it significantly to replace pending tx
        const feeData = await provider.getFeeData();
        const gasPrice = (feeData.gasPrice! * 150n) / 100n; // 50% higher gas price

        // Send a 0 ETH transaction to ourselves with the same nonce to cancel
        const tx = await wallet.sendTransaction({
            to: wallet.address,
            value: 0,
            nonce: currentNonce,
            gasLimit: 21000,
            gasPrice: gasPrice
        });

        console.log('Cancellation tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Cancellation confirmed in block:', receipt?.blockNumber);
    } else {
        console.log('No pending transactions found');
    }
}

cancelPendingTransactions().catch(console.error);