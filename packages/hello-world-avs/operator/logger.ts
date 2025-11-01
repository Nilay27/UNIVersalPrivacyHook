type LogPayload = unknown;

const formatPayload = (payload: LogPayload): string => {
    if (payload === undefined) return '';
    if (payload === null) return 'null';
    if (typeof payload === 'bigint') return payload.toString();
    if (Array.isArray(payload)) {
        try {
            return JSON.stringify(payload, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
            );
        } catch {
            return String(payload);
        }
    }
    if (typeof payload === 'object' && !(payload instanceof Error)) {
        try {
            return JSON.stringify(payload, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
            );
        } catch {
            return String(payload);
        }
    }
    return String(payload);
};

const logWithLevel = (level: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG', message: string, payload?: LogPayload) => {
    const timestamp = new Date().toISOString();
    const formattedPayload = payload !== undefined ? ` | ${formatPayload(payload)}` : '';
    const line = `[${timestamp}] [${level}] ${message}${formattedPayload}`;

    switch (level) {
        case 'ERROR':
            console.error(line);
            break;
        case 'WARN':
            console.warn(line);
            break;
        default:
            console.log(line);
    }
};

export const logger = {
    info: (message: string, payload?: LogPayload) => logWithLevel('INFO', message, payload),
    error: (message: string, payload?: LogPayload) => logWithLevel('ERROR', message, payload),
    warn: (message: string, payload?: LogPayload) => logWithLevel('WARN', message, payload),
    debug: (message: string, payload?: LogPayload) => logWithLevel('DEBUG', message, payload),
};

export default logger;
