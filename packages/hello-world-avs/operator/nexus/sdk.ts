import { NexusSDK, type NexusNetwork } from '@avail-project/nexus-core';
import { ethers } from 'ethers';
import { createEip1193Provider } from './eip1193Provider';
import { ensureWindowShim } from './runtime';

let sdkInstance: NexusSDK | null = null;
let initialized = false;

export interface NexusInitOptions {
    network?: NexusNetwork;
    debug?: boolean;
}

export const initializeNexus = async (
    wallet: ethers.Wallet,
    options: NexusInitOptions = {},
): Promise<NexusSDK> => {
    ensureWindowShim();

    if (sdkInstance && initialized) {
        return sdkInstance;
    }

    const provider = createEip1193Provider(wallet);
    sdkInstance = new NexusSDK({
        network: options.network ?? 'testnet',
        debug: options.debug ?? false,
    });

    await sdkInstance.initialize(provider);
    initialized = true;
    return sdkInstance;
};

export const getNexusSdk = (): NexusSDK => {
    if (!sdkInstance || !initialized) {
        throw new Error('Nexus SDK not initialized. Call initializeNexus() first.');
    }
    return sdkInstance;
};

export const deinitializeNexus = async () => {
    if (sdkInstance && initialized) {
        await sdkInstance.deinit();
        sdkInstance = null;
        initialized = false;
    }
};
