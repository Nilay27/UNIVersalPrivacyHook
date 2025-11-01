import axios, { AxiosError, AxiosInstance } from 'axios';
import { unpack } from 'msgpackr';
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
    ensureAxiosDiagnostics();

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

let axiosDiagnosticsInstalled = false;

const ensureAxiosDiagnostics = () => {
    if (axiosDiagnosticsInstalled) {
        return;
    }

    const registerInterceptors = (instance: AxiosInstance) => {
        instance.interceptors.response.use(
            response => response,
            error => {
                const err = error as AxiosError;
                const target = err.config?.baseURL ?? err.config?.url ?? '';
                if (typeof target === 'string' && target.includes('arcana.network')) {
                    const status = err.response?.status;
                    const statusText = err.response?.statusText;
                    let decoded: unknown = undefined;
                    const data = err.response?.data;
                    if (data) {
                        if (Buffer.isBuffer(data)) {
                            try {
                                decoded = unpack(data);
                            } catch {
                                decoded = data.toString('utf8');
                            }
                        } else if (typeof data === 'string') {
                            decoded = data;
                        } else {
                            decoded = data;
                        }
                    }
                    console.error('[NEXUS_HTTP_ERROR]', {
                        baseURL: err.config?.baseURL,
                        url: err.config?.url,
                        status,
                        statusText,
                        decoded,
                    });
                }
                return Promise.reject(error);
            }
        );
    };

    registerInterceptors(axios);

    const originalCreate = axios.create.bind(axios);
    (axios as unknown as { create: typeof axios.create }).create = (...args) => {
        const instance = originalCreate(...(args as Parameters<typeof axios.create>));
        registerInterceptors(instance);
        return instance;
    };

    axiosDiagnosticsInstalled = true;
};
