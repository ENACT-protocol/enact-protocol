import {
    Address,
    beginCell,
    Cell,
    internal,
    MessageRelaxed,
    SendMode,
    storeMessageRelaxed,
    storeOutList,
} from '@ton/core';
import { sign } from '@ton/crypto';
import type { TonClient } from '@ton/ton';

/**
 * Agentic Wallet provider — alternative signer for ENACT operations
 * that lets an AI agent transact through a TON Tech Agentic Wallet
 * (split-key wallet v5 deployed as an SBT in an NFT collection).
 *
 * The owner mints the wallet on agents.ton.org with the operator's
 * public key. The operator (this provider) signs every outgoing
 * action with its `operatorSecretKey`; the contract verifies the
 * signature against the on-chain `operatorPublicKey` and rejects any
 * mismatch. The owner can revoke or rotate the operator at any time.
 *
 * Contract reference:
 *   https://github.com/the-ton-tech/agentic-wallet-contract
 *   contracts/messages.tolk -> ExternalSignedRequest (opcode 0xbf235204)
 */

/** Opcode of the body parsed by `onExternalMessage`. */
export const EXTERNAL_SIGNED_REQUEST_OPCODE = 0xbf235204;
/** Opcode of the body parsed by `onInternalMessage` for owner-driven sends. */
export const INTERNAL_SIGNED_REQUEST_OPCODE = 0x4a3ca895;

export interface AgenticWalletConfig {
    /** ed25519 secret key of the operator — 64 bytes (seed + pub) as produced by @ton/crypto. */
    operatorSecretKey: Buffer;
    /** Address of the deployed Agentic Wallet contract. */
    agenticWalletAddress: Address;
    /** Optional: the immutable nftItemIndex (uint256). If absent, the provider
     *  fetches it once via `get_subwallet_id()` and caches. */
    walletNftIndex?: bigint;
    /** TonClient used to fetch seqno + nftItemIndex. */
    client: TonClient;
    /** Default validity window in seconds for signed requests (default 60). */
    validitySeconds?: number;
}

/**
 * Build the basic OutAction list cell that holds 1..N relaxed messages
 * to be sent by the agentic wallet. Reuses @ton/core's storeOutList,
 * which writes the standard linked-list format
 * (action_send_msg#0ec3c86d mode:(## 8) out_msg:^MessageRelaxed = OutAction).
 */
function buildOutActionsCell(messages: { mode: number; msg: MessageRelaxed }[]): Cell {
    const actions = messages.map((m) => ({
        type: 'sendMsg' as const,
        mode: m.mode,
        outMsg: m.msg,
    }));
    return beginCell().store(storeOutList(actions as any)).endCell();
}

/**
 * Build the body cell for ExternalSignedRequest (without trailing signature).
 * The 512-bit signature is appended separately after the cell is hashed.
 *
 * Layout (matches contracts/messages.tolk):
 *   opcode (32) || walletNftIndex (256) || validUntil (32) || seqno (32)
 *   || Maybe(^OutActionsCell) || Maybe(^SnakedExtraActions)
 */
function buildSignedRequestBody(params: {
    walletNftIndex: bigint;
    validUntil: number;
    seqno: number;
    outActions: Cell | null;
    extraActions: Cell | null;
    opcode: number;
}): Cell {
    return beginCell()
        .storeUint(params.opcode, 32)
        .storeUint(params.walletNftIndex, 256)
        .storeUint(params.validUntil, 32)
        .storeUint(params.seqno, 32)
        .storeMaybeRef(params.outActions)
        .storeMaybeRef(params.extraActions)
        .endCell();
}

export class AgenticWalletProvider {
    readonly address: Address;
    private operatorSecretKey: Buffer;
    private client: TonClient;
    private validitySeconds: number;
    private cachedNftIndex: bigint | null = null;

    constructor(config: AgenticWalletConfig) {
        if (config.operatorSecretKey.length !== 64) {
            throw new Error('operatorSecretKey must be 64 bytes (ed25519 secret key from @ton/crypto)');
        }
        this.operatorSecretKey = config.operatorSecretKey;
        this.address = config.agenticWalletAddress;
        this.client = config.client;
        this.validitySeconds = config.validitySeconds ?? 60;
        if (config.walletNftIndex !== undefined) this.cachedNftIndex = config.walletNftIndex;
    }

    /** Address of the Agentic Wallet — used as the `from` of every ENACT action. */
    getAddress(): Address {
        return this.address;
    }

    /** Fetch the current seqno from the wallet contract. */
    async fetchSeqno(): Promise<number> {
        const r = await this.client.runMethod(this.address, 'seqno');
        return r.stack.readNumber();
    }

    /** Fetch the immutable nftItemIndex. Cached after first call. */
    async fetchWalletNftIndex(): Promise<bigint> {
        if (this.cachedNftIndex !== null) return this.cachedNftIndex;
        const r = await this.client.runMethod(this.address, 'get_subwallet_id');
        const idx = r.stack.readBigNumber();
        this.cachedNftIndex = idx;
        return idx;
    }

    /**
     * Build, sign and broadcast an external message that asks the wallet
     * to emit `messages`. Each entry pairs a SendMode with a relaxed
     * internal message (created via @ton/core's `internal()` helper).
     */
    async sendTransaction(messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[]): Promise<void> {
        if (messages.length === 0) throw new Error('sendTransaction needs at least one message');

        const seqno = await this.fetchSeqno();
        const walletNftIndex = await this.fetchWalletNftIndex();
        const validUntil = Math.floor(Date.now() / 1000) + this.validitySeconds;

        const relaxedMessages = messages.map((m) => ({
            mode: SendMode.PAY_GAS_SEPARATELY,
            msg: internal({ to: m.to, value: m.value, body: m.body, bounce: m.bounce ?? true }),
        }));
        const outActions = buildOutActionsCell(relaxedMessages);

        const signedBody = buildSignedRequestBody({
            walletNftIndex,
            validUntil,
            seqno,
            outActions,
            extraActions: null,
            opcode: EXTERNAL_SIGNED_REQUEST_OPCODE,
        });

        // The contract hashes the slice that holds the signed request
        // (everything except the 512-bit trailing signature). We sign
        // the cell hash and then append the signature bits.
        const signature = sign(signedBody.hash(), this.operatorSecretKey);
        const finalBody = beginCell()
            .storeBuilder(signedBody.asBuilder())
            .storeBuffer(signature)
            .endCell();

        // Broadcast as an external-in message to the wallet itself.
        await this.client.sendFile(
            beginCell()
                .storeUint(0b10, 2) // ext_in_msg_info$10
                .storeUint(0, 2) // src = addr_none
                .storeAddress(this.address)
                .storeCoins(0) // import_fee
                .storeBit(false) // no stateInit
                .storeBit(true) // body in ref
                .storeRef(finalBody)
                .endCell()
                .toBoc(),
        );
    }
}

/**
 * Detect whether `address` is an Agentic Wallet by probing the
 * standard get-methods. Returns `null` if any required method throws
 * or returns inconsistent data — that's the signal to treat the
 * address as a regular wallet.
 *
 * Used by the explorer / MCP `detect_agentic_wallet` tool. The check
 * is conservative: any failure → not an agentic wallet.
 */
export interface AgenticWalletInfo {
    isAgenticWallet: true;
    ownerAddress: Address;
    operatorPublicKey: Buffer;
    originOperatorPublicKey: Buffer;
    collectionAddress: Address;
    nftItemIndex: bigint;
    revokedAt: bigint;
    isRevoked: boolean;
}

export async function detectAgenticWallet(
    client: TonClient,
    address: Address,
): Promise<AgenticWalletInfo | null> {
    try {
        const [pkRes, originRes, nftRes, authRes, revokedRes] = await Promise.all([
            client.runMethod(address, 'get_public_key'),
            client.runMethod(address, 'get_origin_public_key'),
            client.runMethod(address, 'get_nft_data'),
            client.runMethod(address, 'get_authority_address'),
            client.runMethod(address, 'get_revoked_time'),
        ]);

        const operatorPubBig = pkRes.stack.readBigNumber();
        const originPubBig = originRes.stack.readBigNumber();
        // get_nft_data returns: init?, index, collection_addr, owner_addr, content
        nftRes.stack.readNumber(); // init
        const nftItemIndex = nftRes.stack.readBigNumber();
        const collectionFromNft = nftRes.stack.readAddress();
        const ownerAddress = nftRes.stack.readAddress();
        nftRes.stack.skip(1); // content cell — not needed here
        const collectionAddress = authRes.stack.readAddress();
        const revokedAt = revokedRes.stack.readBigNumber();

        const toBuf = (n: bigint): Buffer => {
            const hex = n.toString(16).padStart(64, '0');
            return Buffer.from(hex, 'hex');
        };

        return {
            isAgenticWallet: true,
            ownerAddress,
            operatorPublicKey: toBuf(operatorPubBig),
            originOperatorPublicKey: toBuf(originPubBig),
            collectionAddress: collectionAddress ?? collectionFromNft,
            nftItemIndex,
            revokedAt,
            // Operator is considered revoked when the owner has zeroed
            // the operatorPublicKey on-chain.
            isRevoked: operatorPubBig === 0n,
        };
    } catch {
        return null;
    }
}

/**
 * One-shot helper for the MCP `generate_agent_keypair` tool. Returns
 * an ed25519 keypair plus a deeplink to agents.ton.org/create with
 * the public key prefilled, so the user can open the dashboard and
 * mint a new Agentic Wallet on top of this operator key.
 */
export async function generateAgentKeypair(agentName?: string): Promise<{
    publicKeyHex: string;
    secretKeyHex: string;
    createDeeplink: string;
}> {
    const { keyPairFromSeed } = await import('@ton/crypto');
    const { randomBytes } = await import('crypto');
    const kp = keyPairFromSeed(randomBytes(32));
    const params = new URLSearchParams({ operatorPublicKey: kp.publicKey.toString('hex') });
    if (agentName) params.set('name', agentName);
    return {
        publicKeyHex: kp.publicKey.toString('hex'),
        secretKeyHex: kp.secretKey.toString('hex'),
        createDeeplink: `https://agents.ton.org/create?${params.toString()}`,
    };
}
