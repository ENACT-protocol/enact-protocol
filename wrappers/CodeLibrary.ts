import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core';

// Masterchain library publisher. Deployed on workchain -1. Owner sends
// RegisterLibrary { mode, libraryCode } and the contract emits a
// raw `action_change_library` out-action (opcode 0x26fa1dd4) with the
// given mode. Mode=2 publishes to the global library dict so every
// shard can reference the code via an exotic library-ref cell.

export const CodeLibraryOpcodes = {
    registerLibrary: 0x9c6a0ee4, // CRC32("lib::register")
};

export const LibraryMode = {
    PRIVATE: 1,
    PUBLIC: 2,
} as const;

export type CodeLibraryConfig = {
    owner: Address;
};

export function codeLibraryConfigToCell(config: CodeLibraryConfig): Cell {
    return beginCell().storeAddress(config.owner).endCell();
}

export class CodeLibrary implements Contract {
    abi: ContractABI = { name: 'CodeLibrary' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new CodeLibrary(address);
    }

    // workchain -1 — library actions are only accepted on masterchain.
    static createFromConfig(config: CodeLibraryConfig, code: Cell, workchain = -1) {
        const data = codeLibraryConfigToCell(config);
        const init = { code, data };
        return new CodeLibrary(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendRegisterLibrary(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { mode?: number; libraryCode: Cell },
    ) {
        const mode = params.mode ?? LibraryMode.PUBLIC;
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CodeLibraryOpcodes.registerLibrary, 32)
                .storeUint(mode, 8)
                .storeRef(params.libraryCode)
                .endCell(),
        });
    }

    async getOwner(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('owner', []);
        return r.stack.readAddress();
    }
}

// Helper: build the exotic library-reference cell that holds a
// 32-byte code hash. The cell has `isExotic` flag set and 8+256 bits
// of data: 0x02 (library-ref tag) + code hash.
export function buildLibraryRefCell(codeHash: Buffer): Cell {
    if (codeHash.length !== 32) {
        throw new Error('library code hash must be 32 bytes');
    }
    const bits = beginCell().storeUint(2, 8).storeBuffer(codeHash).endCell();
    // The two cells above differ only in `isExotic`. @ton/core's Cell
    // constructor accepts the flag directly.
    return new Cell({
        exotic: true,
        bits: bits.bits,
        refs: [],
    });
}
