export const CHAIN_IDS = {
    BASE_SEPOLIA: 84532,
    ETHEREUM_SEPOLIA: 11155111,
} as const;

export type ChainIdLiteral = typeof CHAIN_IDS[keyof typeof CHAIN_IDS];

export interface ChainDeployment {
    tokens?: Record<string, string>;
    protocols?: Record<string, string>;
    markets?: Record<string, string>;
    swapManager?: string;
    boringVault?: string;
}

export const CHAIN_DEPLOYMENTS: Record<ChainIdLiteral, ChainDeployment> = {
    [CHAIN_IDS.BASE_SEPOLIA]: {
        tokens: {
            USDC: "0x9c14aC9E88Eb84Fc341291FBf06B891592E3bcC7",
            USDT: "0x0f1333EaFF107C4d205d2d80b567D003d7870ad5",
            PT_eUSDE: "0xFF9F206B333C902Af93426f7b6630F103cB85309",
            PT_sUSDE: "0x4cabe68B3C6d65F7f12cDDa41998257b6E16DF16",
            PT_USR: "0xfB8C7bE6BAfB392BF2386EBD616916f08e2d5E1f",
        },
        protocols: {
            pendle: "0x81095fCdb1502B986a6A3ce33323412d45167364",
            aave: "0x7cAC40567e1891902eeafE3fD10FfC3ED4043252",
            morpho: "0x909D68D8A57Ab8F62B6391e117a77B215Ab21Dfc",
        },
        markets: {
            PT_eUSDE: "0x757f4cAf00AFcd41F8389Eb5dE4a8a737a262D45",
            PT_sUSDE: "0xfeCb7785CA797A709095F4146140329fCf970FE8",
            PT_USR: "0xB909F6b859910ad59D2F4003cd8610Af4fa41Fef",
        },
        swapManager: undefined,
        boringVault: undefined,
    },
    [CHAIN_IDS.ETHEREUM_SEPOLIA]: {
        tokens: {
            USDC: "0x59dd1A3Bd1256503cdc023bfC9f10e107d64C3C1",
            USDT: "0xB1D9519e953B8513a4754f9B33d37eDba90c001D",
        },
        protocols: {
            // Populate with deployed protocol entry points on Sepolia
        },
        markets: {
            // Populate if markets are required for logging/UI
        },
        swapManager: "0x04452661c2F3f91594eD5E7ab341281a2E1A04b4",
        boringVault: "0x1B7Bbc206Fc58413dCcDC9A4Ad1c5a95995a3926",
    },
};
