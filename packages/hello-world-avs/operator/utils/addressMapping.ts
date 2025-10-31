import { ethers } from "ethers";
import { CHAIN_DEPLOYMENTS, CHAIN_IDS, ChainIdLiteral } from "../config/chains";

type AddressCategory = "tokens" | "protocols" | "markets";

type CanonicalEntry = {
    category: AddressCategory;
    key: string;
};

const CANONICAL_CHAIN = CHAIN_IDS.ETHEREUM_SEPOLIA;

const canonicalDeployment = CHAIN_DEPLOYMENTS[CANONICAL_CHAIN];

function normalize(address: string): string {
    return ethers.getAddress(address).toLowerCase();
}

const canonicalLookup: Record<string, CanonicalEntry> = (() => {
    if (!canonicalDeployment) {
        return {};
    }

    const entries: Record<string, CanonicalEntry> = {};

    const categories: AddressCategory[] = ["tokens", "protocols", "markets"];

    for (const category of categories) {
        const mapping = canonicalDeployment[category];
        if (!mapping) continue;

        for (const [key, address] of Object.entries(mapping)) {
            if (!address) continue;
            try {
                entries[normalize(address)] = { category, key };
            } catch {
                // skip invalid address
            }
        }
    }

    return entries;
})();

export function mapAddressForChain(address: string, targetChainId: number): string {
    try {
        const canonicalKey = canonicalLookup[normalize(address)];
        if (!canonicalKey) {
            return ethers.getAddress(address);
        }

        const targetDeployment = CHAIN_DEPLOYMENTS[targetChainId as ChainIdLiteral];
        if (!targetDeployment) {
            return ethers.getAddress(address);
        }

        const categoryMapping = targetDeployment[canonicalKey.category];
        if (!categoryMapping) {
            return ethers.getAddress(address);
        }

        const targetAddress = categoryMapping[canonicalKey.key];
        if (!targetAddress) {
            return ethers.getAddress(address);
        }

        return ethers.getAddress(targetAddress);
    } catch {
        return ethers.getAddress(address);
    }
}
