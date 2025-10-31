import { ethers } from "ethers";
import {
    ChainId,
    ProtocolCallLookupResult,
    ProtocolFunction,
    ProtocolTargetEntry,
} from "./protocolTypes";

function parseArgTypes(signature: string): string[] {
    const start = signature.indexOf("(");
    const end = signature.indexOf(")", start);
    if (start === -1 || end === -1 || end <= start + 1) {
        return [];
    }

    const argsSection = signature.slice(start + 1, end).trim();
    if (!argsSection) {
        return [];
    }

    return argsSection.split(",").map((arg) => arg.trim());
}

function normalizeSelector(selector: string): string {
    const prefixed = selector.startsWith("0x") ? selector : `0x${selector}`;
    return prefixed.toLowerCase();
}

function normalizeAddress(address: string): string {
    return address.toLowerCase();
}

export function getSelector(signature: string): string {
    return ethers.id(signature).slice(0, 10);
}

const PROTOCOL_FUNCTIONS: ProtocolFunction[] = [
    {
        protocol: "pendle",
        functionName: "swapExactTokenForPt",
        signature: "swapExactTokenForPt(address,address,address,uint256)",
        selector: getSelector("swapExactTokenForPt(address,address,address,uint256)"),
        argNames: ["receiver", "market", "tokenIn", "netTokenIn"],
        argTypes: parseArgTypes("swapExactTokenForPt(address,address,address,uint256)"),
    },
    {
        protocol: "pendle",
        functionName: "swapExactPtForToken",
        signature: "swapExactPtForToken(address,address,uint256,address)",
        selector: getSelector("swapExactPtForToken(address,address,uint256,address)"),
        argNames: ["receiver", "market", "exactPtIn", "tokenOut"],
        argTypes: parseArgTypes("swapExactPtForToken(address,address,uint256,address)"),
    },
    {
        protocol: "morpho",
        functionName: "supply",
        signature: "supply(address,uint256,address)",
        selector: getSelector("supply(address,uint256,address)"),
        argNames: ["collateralToken", "collateralTokenAmount", "onBehalf"],
        argTypes: parseArgTypes("supply(address,uint256,address)"),
    },
    {
        protocol: "morpho",
        functionName: "borrow",
        signature: "borrow(address,address,uint256,uint256,address,address)",
        selector: getSelector("borrow(address,address,uint256,uint256,address,address)"),
        argNames: ["loanToken", "collateralToken", "lltv", "assets", "onBehalf", "receiver"],
        argTypes: parseArgTypes("borrow(address,address,uint256,uint256,address,address)"),
    },
    {
        protocol: "morpho",
        functionName: "withdraw",
        signature: "withdraw(address,uint256,address,address)",
        selector: getSelector("withdraw(address,uint256,address,address)"),
        argNames: ["asset", "amount", "onBehalf", "receiver"],
        argTypes: parseArgTypes("withdraw(address,uint256,address,address)"),
    },
    {
        protocol: "morpho",
        functionName: "repay",
        signature: "repay(address,address,uint256,address)",
        selector: getSelector("repay(address,address,uint256,address)"),
        argNames: ["loanToken", "collateralToken", "assets", "onBehalf"],
        argTypes: parseArgTypes("repay(address,address,uint256,address)"),
    },
    {
        protocol: "aave",
        functionName: "supply",
        signature: "supply(address,uint256,address,uint16)",
        selector: getSelector("supply(address,uint256,address,uint16)"),
        argNames: ["asset", "amount", "onBehalfOf", "referralCode"],
        argTypes: parseArgTypes("supply(address,uint256,address,uint16)"),
    },
    {
        protocol: "aave",
        functionName: "withdraw",
        signature: "withdraw(address,uint256,address)",
        selector: getSelector("withdraw(address,uint256,address)"),
        argNames: ["asset", "amount", "to"],
        argTypes: parseArgTypes("withdraw(address,uint256,address)"),
    },
    {
        protocol: "aave",
        functionName: "borrow",
        signature: "borrow(address,uint256,uint256,uint16,address)",
        selector: getSelector("borrow(address,uint256,uint256,uint16,address)"),
        argNames: ["asset", "amount", "interestRateMode", "referralCode", "onBehalfOf"],
        argTypes: parseArgTypes("borrow(address,uint256,uint256,uint16,address)"),
    },
    {
        protocol: "aave",
        functionName: "repay",
        signature: "repay(address,uint256,uint256,address)",
        selector: getSelector("repay(address,uint256,uint256,address)"),
        argNames: ["asset", "amount", "interestRateMode", "onBehalfOf"],
        argTypes: parseArgTypes("repay(address,uint256,uint256,address)"),
    },
    {
        protocol: "compound",
        functionName: "supply",
        signature: "supply(address,uint256)",
        selector: getSelector("supply(address,uint256)"),
        argNames: ["asset", "amount"],
        argTypes: parseArgTypes("supply(address,uint256)"),
    },
    {
        protocol: "compound",
        functionName: "withdraw",
        signature: "withdraw(address,uint256)",
        selector: getSelector("withdraw(address,uint256)"),
        argNames: ["asset", "amount"],
        argTypes: parseArgTypes("withdraw(address,uint256)"),
    },
    {
        protocol: "erc20",
        functionName: "transfer",
        signature: "transfer(address,uint256)",
        selector: getSelector("transfer(address,uint256)"),
        argNames: ["to", "amount"],
        argTypes: parseArgTypes("transfer(address,uint256)"),
    },
];

const functionLookup = new Map<string, ProtocolFunction>();
const selectorLookup = new Map<string, ProtocolFunction[]>();

for (const fn of PROTOCOL_FUNCTIONS) {
    const key = `${fn.protocol}|${normalizeSelector(fn.selector)}`;
    functionLookup.set(key, fn);

    const selectorKey = normalizeSelector(fn.selector);
    const list = selectorLookup.get(selectorKey) ?? [];
    list.push(fn);
    selectorLookup.set(selectorKey, list);
}

const PROTOCOL_TARGETS: Record<ChainId, Record<string, ProtocolTargetEntry>> = {};

export function registerProtocolTargets(
    chainId: ChainId,
    targets: Record<string, ProtocolTargetEntry>
): void {
    const normalizedEntries: Record<string, ProtocolTargetEntry> = {};
    for (const [address, entry] of Object.entries(targets)) {
        normalizedEntries[normalizeAddress(address)] = entry;
    }
    PROTOCOL_TARGETS[chainId] = normalizedEntries;
}

export function getRegisteredProtocols(
    chainId: ChainId
): Record<string, ProtocolTargetEntry> | undefined {
    return PROTOCOL_TARGETS[chainId];
}

function transformArgument(type: string, value: bigint): string | bigint {
    if (type === "address") {
        return ethers.getAddress(ethers.toBeHex(value, 20));
    }

    if (type.startsWith("uint") || type.startsWith("int")) {
        const bitSize = Number(type.slice(type.startsWith("uint") ? 4 : 3)) || 256;
        const maxValue = (1n << BigInt(bitSize)) - 1n;
        if (value < 0n || value > maxValue) {
            throw new Error(`Value ${value} does not fit into ${type}`);
        }
        return value;
    }

    if (type.startsWith("bytes")) {
        const byteSize = type === "bytes" ? undefined : Number(type.slice(5));
        const hexValue = ethers.toBeHex(value, byteSize ?? 32);
        if (!byteSize) {
            return hexValue;
        }
        return hexValue;
    }

    throw new Error(`Unsupported argument type: ${type}`);
}

export function prepareProtocolArguments(
    definition: ProtocolCallLookupResult,
    rawArgs: readonly bigint[]
): (string | bigint)[] {
    if (definition.argTypes.length !== rawArgs.length) {
        throw new Error(
            `Argument length mismatch for ${definition.signature}: expected ${definition.argTypes.length}, got ${rawArgs.length}`
        );
    }

    return definition.argTypes.map((type, index) =>
        transformArgument(type, rawArgs[index])
    );
}

export function encodeProtocolCalldata(
    definition: ProtocolCallLookupResult,
    rawArgs: readonly bigint[]
): string {
    const transformedArgs = prepareProtocolArguments(definition, rawArgs);
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
        definition.argTypes,
        transformedArgs
    );

    return normalizeSelector(definition.selector) + encodedArgs.slice(2);
}

export function resolveProtocolCall(
    chainId: ChainId,
    target: string,
    selector: string
): ProtocolCallLookupResult {
    const normalizedTarget = normalizeAddress(target);
    const normalizedSelector = normalizeSelector(selector);

    const chainTargets = PROTOCOL_TARGETS[chainId];
    let protocol: string | undefined;

    if (chainTargets) {
        const targetEntry = chainTargets[normalizedTarget];
        protocol = targetEntry?.protocol;
    }

    if (protocol) {
        const fn = functionLookup.get(`${protocol}|${normalizedSelector}`);
        if (!fn) {
            throw new Error(
                `No function metadata for protocol "${protocol}" with selector ${normalizedSelector}`
            );
        }
        return {
            ...fn,
            target: ethers.getAddress(target),
            chainId,
        };
    }

    const selectorMatches = selectorLookup.get(normalizedSelector) || [];
    if (selectorMatches.length === 1) {
        const fn = selectorMatches[0];
        return {
            ...fn,
            target: ethers.getAddress(target),
            chainId,
        };
    }

    if (selectorMatches.length > 1) {
        const protocols = selectorMatches.map((fn) => fn.protocol).join(", ");
        throw new Error(
            `Ambiguous selector ${normalizedSelector}. Matches protocols: ${protocols}. Register protocol targets to disambiguate.`
        );
    }

    throw new Error(
        `Unknown selector ${normalizedSelector}. Register the function metadata before processing.`
    );
}

export { PROTOCOL_FUNCTIONS };
