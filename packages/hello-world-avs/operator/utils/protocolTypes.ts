export type ChainId = number;

export interface ProtocolFunction {
    protocol: string;
    functionName: string;
    signature: string;
    selector: string;
    argNames: string[];
    argTypes: string[];
}

export interface ProtocolTargetEntry {
    protocol: string;
    description?: string;
}

export interface ProtocolCallDefinition extends ProtocolFunction {
    target: string;
    chainId: ChainId;
}

export interface ProtocolCallLookupResult {
    protocol: string;
    functionName: string;
    signature: string;
    selector: string;
    argNames: string[];
    argTypes: string[];
    target: string;
    chainId: ChainId;
}
