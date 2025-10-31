import { webcrypto } from 'node:crypto';

/**
 * Ensure the minimal browser-like globals the Nexus SDK expects.
 * Safe to call multiple times.
 */
export const ensureWindowShim = () => {
    if (typeof globalThis.window !== 'undefined') {
        // window already exists; make sure crypto is exposed as well.
        if (typeof globalThis.crypto === 'undefined') {
            (globalThis as any).crypto = globalThis.window.crypto ?? webcrypto;
        }
        return;
    }

    const noop = () => undefined;
    const protocol = 'https:';
    const host = 'localhost';
    const origin = `${protocol}//${host}`;

    const shim: any = {
        crypto: webcrypto,
        setTimeout: setTimeout.bind(globalThis),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: setInterval.bind(globalThis),
        clearInterval: clearInterval.bind(globalThis),
        location: {
            protocol,
            host,
            origin,
            href: `${origin}/`,
            pathname: '/',
            search: '',
            hash: '',
        },
        addEventListener: noop,
        removeEventListener: noop,
        navigator: {
            userAgent: 'node',
        },
    };

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const NodeWebSocket = require('ws');
        if (NodeWebSocket && typeof globalThis.WebSocket === 'undefined') {
            globalThis.WebSocket = NodeWebSocket;
            shim.WebSocket = NodeWebSocket;
        }
    } catch {
        // If ws is not available, continue without WebSocket support.
    }

    globalThis.window = shim;

    if (typeof globalThis.crypto === 'undefined') {
        (globalThis as any).crypto = webcrypto;
    }
};
