import { ChainDeployment, CHAIN_DEPLOYMENTS } from "./chains";
import { ChainId, ProtocolTargetEntry } from "../utils/protocolTypes";
import { registerProtocolTargets } from "../utils/protocolRegistry";

export type ProtocolAddressBook = Record<string, ProtocolTargetEntry>;

export type ChainProtocolTargets = Record<ChainId, ProtocolAddressBook>;

function buildProtocolAddressBook(deployment: ChainDeployment): ProtocolAddressBook {
    const entries: ProtocolAddressBook = {};
    if (deployment.protocols) {
        for (const [protocol, address] of Object.entries(deployment.protocols)) {
            if (!address) continue;
            entries[address] = {
                protocol,
                description: `${protocol} entry point`,
            };
        }
    }
    return entries;
}

export const CHAIN_PROTOCOL_TARGETS: ChainProtocolTargets = Object.entries(
    CHAIN_DEPLOYMENTS
).reduce((acc, [chainIdStr, deployment]) => {
    const chainId = Number(chainIdStr) as ChainId;
    const addressBook = buildProtocolAddressBook(deployment);
    if (Object.keys(addressBook).length > 0) {
        acc[chainId] = addressBook;
    }
    return acc;
}, {} as ChainProtocolTargets);

export function registerConfiguredProtocolTargets(chainId?: ChainId): void {
    if (chainId !== undefined) {
        const targets = CHAIN_PROTOCOL_TARGETS[chainId];
        if (targets) {
            registerProtocolTargets(chainId, targets);
        }
        return;
    }

    for (const [chainKey, targets] of Object.entries(CHAIN_PROTOCOL_TARGETS)) {
        if (!targets) continue;
        const numericChainId = Number(chainKey) as ChainId;
        registerProtocolTargets(numericChainId, targets);
    }
}
