import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { Address, beginCell, Cell, toNano, TonClient, WalletContractV5R1, internal, SendMode, storeOutList } from '@ton/ton';
import { keyPairFromSeed, mnemonicToPrivateKey, sign } from '@ton/crypto';
import { randomBytes, randomUUID } from 'crypto';
import { config } from './config.js';
import nacl from 'tweetnacl';
import ed2curve from 'ed2curve';

const FactoryOpcodes = { createJob: 0x00000010 };
const JobOpcodes = {
    fund: 0x00000001,
    takeJob: 0x00000002,
    submitResult: 0x00000003,
    evaluate: 0x00000004,
    cancel: 0x00000005,
    claim: 0x00000007,
    quit: 0x00000008,
    setBudget: 0x00000009,
    setJettonWallet: 0x0000000a,
};

// ─── Encrypted Result types ───

interface EncryptedEnvelope {
    type: 'job_result_encrypted';
    version: 1;
    senderPublicKey: string;
    recipients: { role: 'client' | 'evaluator'; encryptedKey: string; nonce: string }[];
    ciphertext: string;
    nonce: string;
    submittedAt: string;
}

function encryptResult(
    result: string,
    senderSecretKey: Buffer,
    senderPublicKey: Buffer,
    recipientPublicKeys: { client: Buffer; evaluator: Buffer },
): EncryptedEnvelope {
    const senderX25519Sec = ed2curve.convertSecretKey(new Uint8Array(senderSecretKey));
    const secretKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(new TextEncoder().encode(result), nonce, secretKey);
    const recipients: EncryptedEnvelope['recipients'] = [];
    for (const [role, pubKey] of [['client', recipientPublicKeys.client], ['evaluator', recipientPublicKeys.evaluator]] as const) {
        const recipientX25519Pub = ed2curve.convertPublicKey(new Uint8Array(pubKey));
        if (!recipientX25519Pub) throw new Error(`Failed to convert ${role} public key to x25519`);
        const boxNonce = nacl.randomBytes(nacl.box.nonceLength);
        const encryptedKey = nacl.box(secretKey, boxNonce, recipientX25519Pub, senderX25519Sec);
        recipients.push({ role, encryptedKey: Buffer.from(encryptedKey).toString('base64'), nonce: Buffer.from(boxNonce).toString('base64') });
    }
    return { type: 'job_result_encrypted', version: 1, senderPublicKey: senderPublicKey.toString('hex'), recipients, ciphertext: Buffer.from(ciphertext).toString('base64'), nonce: Buffer.from(nonce).toString('base64'), submittedAt: new Date().toISOString() };
}

function decryptResultEnvelope(envelope: EncryptedEnvelope, role: 'client' | 'evaluator', recipientSecretKey: Buffer): string {
    const recipient = envelope.recipients.find(r => r.role === role);
    if (!recipient) throw new Error(`No encrypted key for role: ${role}`);
    const recipientX25519Sec = ed2curve.convertSecretKey(new Uint8Array(recipientSecretKey));
    const senderX25519Pub = ed2curve.convertPublicKey(new Uint8Array(Buffer.from(envelope.senderPublicKey, 'hex')));
    if (!senderX25519Pub) throw new Error('Failed to convert sender public key');
    const encKey = new Uint8Array(Buffer.from(recipient.encryptedKey, 'base64'));
    const boxNonce = new Uint8Array(Buffer.from(recipient.nonce, 'base64'));
    const secretKey = nacl.box.open(encKey, boxNonce, senderX25519Pub, recipientX25519Sec);
    if (!secretKey) throw new Error('Decryption failed — wrong key or corrupted data');
    const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, 'base64'));
    const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'base64'));
    const plaintext = nacl.secretbox.open(ciphertext, nonce, secretKey);
    if (!plaintext) throw new Error('Decryption failed — corrupted ciphertext');
    return new TextDecoder().decode(plaintext);
}

async function getWalletPublicKey(address: string): Promise<Buffer> {
    const result = await client.runMethod(Address.parse(address), 'get_public_key');
    const pubKeyInt = result.stack.readBigNumber();
    return Buffer.from(pubKeyInt.toString(16).padStart(64, '0'), 'hex');
}

let client: TonClient;
let wallet: WalletContractV5R1 | undefined;
let keyPair: { publicKey: Buffer; secretKey: Buffer } | undefined;

/**
 * Per-session Agentic Wallet signer state. Activated by the
 * `configure_agentic_wallet` tool; once set every subsequent
 * transaction tool in the SAME MCP session routes through this
 * signer instead of the mnemonic wallet. Each MCP HTTP session and
 * each stdio connection gets its own fresh AgenticState — operator
 * secrets never leak between users on the multi-tenant remote MCP.
 */
interface AgenticState {
    operatorSecretKey?: Buffer;
    walletAddress?: Address;
    nftIndex?: bigint;
}

async function init() {
    client = new TonClient({ endpoint: config.endpoint, apiKey: config.apiKey });
    if (config.walletMnemonic.length > 0) {
        keyPair = await mnemonicToPrivateKey(config.walletMnemonic);
        wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
        console.error(`ENACT MCP: signing mode (wallet ${wallet.address.toString()})`);
    } else {
        console.error('ENACT MCP: unsigned mode (no wallet — returns prepared transactions)');
    }
}

function prepareTransaction(to: Address, value: bigint, body: Cell) {
    const boc = body.toBoc().toString('base64');
    const bocUrl = boc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const toStr = to.toString();
    return {
        to: toStr,
        value_nano: value.toString(),
        payload_boc_base64: boc,
        tonkeeper_url: `https://app.tonkeeper.com/transfer/${toStr}?amount=${value}&bin=${bocUrl}`,
    };
}

async function sendTransaction(agentic: AgenticState, to: Address, value: bigint, body: Cell) {
    // Agentic Wallet path takes precedence: signed external request
    // with operator key, no mnemonic involved. The provider is
    // inlined here (rather than imported from sdk/) so the MCP
    // server stays self-contained and the SDK npm package is not a
    // hard runtime dependency.
    if (agentic.operatorSecretKey && agentic.walletAddress) {
        const startSeqno = await fetchAgenticSeqno(agentic.walletAddress);
        await sendAgenticExternal(agentic, [
            { to, value, body, bounce: true },
        ]);
        // Wait for the wallet to actually accept the external — seqno only
        // advances on a successful compute_ph + action_ph. Catches the
        // historic SEND_MODE bug (exit code 137) and any future signature /
        // validUntil mismatch instead of returning a misleading "executed".
        let confirmed = false;
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const cur = await fetchAgenticSeqno(agentic.walletAddress);
                if (cur > startSeqno) { confirmed = true; break; }
            } catch {}
        }
        if (!confirmed) {
            throw new Error('Agentic wallet did not advance seqno within 12s — the external was rejected (likely SEND_MODE / signature / nft_index / validUntil mismatch). The factory message was NOT delivered.');
        }
        return {
            status: 'executed' as const,
            mode: 'agentic-wallet' as const,
            walletAddress: agentic.walletAddress.toString(),
            seqnoAfter: startSeqno + 1,
        };
    }
    if (wallet && keyPair) {
        const contract = client.open(wallet);
        const seqno = await contract.getSeqno();
        await contract.sendTransfer({
            seqno,
            secretKey: keyPair.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to, value, body, bounce: true })],
        });
        return { status: 'executed' as const, seqno, walletAddress: wallet.address.toString() };
    }
    return {
        status: 'prepared' as const,
        message: 'Transaction prepared. Sign and send with your wallet.',
        ...prepareTransaction(to, value, body),
    };
}

// ─── Agentic Wallet helpers ───
// See sdk/src/providers/AgenticWalletProvider.ts for the full
// reference implementation; the helpers below are an inlined,
// dependency-free copy used by the MCP transaction path.

const EXTERNAL_SIGNED_REQUEST_OPCODE = 0xbf235204;

async function fetchAgenticSeqno(addr: Address): Promise<number> {
    const r = await client.runMethod(addr, 'seqno');
    return r.stack.readNumber();
}

async function fetchAgenticNftIndex(addr: Address): Promise<bigint> {
    const r = await client.runMethod(addr, 'get_subwallet_id');
    return r.stack.readBigNumber();
}

async function sendAgenticExternal(
    agentic: AgenticState,
    messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[],
): Promise<void> {
    if (!agentic.operatorSecretKey || !agentic.walletAddress) {
        throw new Error('Agentic wallet not configured for this session.');
    }
    if (agentic.operatorSecretKey.length !== 64) {
        throw new Error('operatorSecretKey must be the 64-byte ed25519 secret key');
    }
    const walletAddress = agentic.walletAddress;
    const operatorSecretKey = agentic.operatorSecretKey;
    const seqno = await fetchAgenticSeqno(walletAddress);
    const nftIndex = agentic.nftIndex ?? (await fetchAgenticNftIndex(walletAddress));
    if (agentic.nftIndex === undefined) agentic.nftIndex = nftIndex;
    const validUntil = Math.floor(Date.now() / 1000) + 60;

    const actions = messages.map((m) => ({
        type: 'sendMsg' as const,
        // PAY_GAS_SEPARATELY (1) | IGNORE_ERRORS (2) = 3. The agentic wallet
        // contract's c5-register-validation rejects sendMsg actions whose
        // mode lacks IGNORE_ERRORS — wallet processes the external (seqno
        // bumps), action phase throws exit code 137, and out_msgs stays
        // empty. The factory never sees the createJob message even though
        // the operator key signed correctly. Same flag pair is used by the
        // SDK's AgenticWalletProvider.
        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        outMsg: internal({ to: m.to, value: m.value, body: m.body, bounce: m.bounce ?? true }),
    }));
    const outActions = beginCell().store(storeOutList(actions as any)).endCell();

    const signedBody = beginCell()
        .storeUint(EXTERNAL_SIGNED_REQUEST_OPCODE, 32)
        .storeUint(nftIndex, 256)
        .storeUint(validUntil, 32)
        .storeUint(seqno, 32)
        .storeMaybeRef(outActions)
        .storeMaybeRef(null)
        .endCell();

    const signature = sign(signedBody.hash(), operatorSecretKey);
    const finalBody = beginCell().storeBuilder(signedBody.asBuilder()).storeBuffer(signature).endCell();

    await client.sendFile(
        beginCell()
            .storeUint(0b10, 2)
            .storeUint(0, 2)
            .storeAddress(walletAddress)
            .storeCoins(0)
            .storeBit(false)
            .storeBit(true)
            .storeRef(finalBody)
            .endCell()
            .toBoc(),
    );
}

interface AgenticDetectionResult {
    isAgenticWallet: boolean;
    ownerAddress?: string;
    operatorPublicKey?: string;
    originOperatorPublicKey?: string;
    collectionAddress?: string;
    nftItemIndex?: string;
    revokedAt?: string;
    isRevoked?: boolean;
}

async function detectAgenticWalletMcp(addressStr: string): Promise<AgenticDetectionResult> {
    // Five sequential calls with per-call retry on 429. Running them in
    // parallel reliably trips toncenter's free-tier rate limit and the catch
    // labels real agentic wallets as "regular v5". One call at a time + 4
    // retries with linear backoff keeps detection accurate even on a busy
    // factory.
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const runWithRetry = async <T>(fn: () => Promise<T>, attempts = 4): Promise<T | null> => {
        for (let i = 0; i < attempts; i++) {
            try { return await fn(); }
            catch (e: any) {
                const msg = e?.message || String(e);
                if (i === attempts - 1) return null;
                if (msg.includes('429') || msg.toLowerCase().includes('too many') || msg.includes('Ratelimit')) {
                    await sleep(700 * (i + 1));
                    continue;
                }
                return null;
            }
        }
        return null;
    };

    try {
        const addr = Address.parse(addressStr);
        const pkRes = await runWithRetry(() => client.runMethod(addr, 'get_public_key'));
        if (!pkRes) return { isAgenticWallet: false };
        const originRes = await runWithRetry(() => client.runMethod(addr, 'get_origin_public_key'));
        if (!originRes) return { isAgenticWallet: false };
        const nftRes = await runWithRetry(() => client.runMethod(addr, 'get_nft_data'));
        if (!nftRes) return { isAgenticWallet: false };
        const authRes = await runWithRetry(() => client.runMethod(addr, 'get_authority_address'));
        const revokedRes = await runWithRetry(() => client.runMethod(addr, 'get_revoked_time'));

        const operatorPubBig = pkRes.stack.readBigNumber();
        const originPubBig = originRes.stack.readBigNumber();
        nftRes.stack.readNumber();
        const nftItemIndex = nftRes.stack.readBigNumber();
        const collectionFromNft = nftRes.stack.readAddress();
        const ownerAddress = nftRes.stack.readAddress();
        nftRes.stack.skip(1);
        let collectionAddress = collectionFromNft;
        if (authRes) {
            try { collectionAddress = authRes.stack.readAddress() ?? collectionFromNft; }
            catch { collectionAddress = collectionFromNft; }
        }
        const revokedAt = revokedRes ? revokedRes.stack.readBigNumber() : 0n;
        const toHex = (n: bigint) => n.toString(16).padStart(64, '0');
        return {
            isAgenticWallet: true,
            ownerAddress: ownerAddress.toString({ bounceable: false }),
            operatorPublicKey: toHex(operatorPubBig),
            originOperatorPublicKey: toHex(originPubBig),
            collectionAddress: collectionAddress.toString(),
            nftItemIndex: nftItemIndex.toString(),
            revokedAt: revokedAt.toString(),
            isRevoked: operatorPubBig === 0n,
        };
    } catch {
        return { isAgenticWallet: false };
    }
}

// ─── IPFS via Lighthouse.storage (primary) + Pinata (fallback) ───

function sha256hex(text: string): string {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function uploadToLighthouse(buffer: Buffer, filename: string, mimeType: string): Promise<string | null> {
    const key = process.env.LIGHTHOUSE_API_KEY;
    if (!key) return null;
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    // Endpoint per official SDK config: upload.lighthouse.storage.
    const res = await fetch('https://upload.lighthouse.storage/api/v0/add?cid-version=1', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}` },
        body: fd,
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Lighthouse upload failed: ${res.status} ${errText.slice(0, 100)}`);
    }
    const data = await res.json() as { Hash?: string };
    return data.Hash ?? null;
}

async function uploadToIPFS(content: object): Promise<{ cid: string; hash: string }> {
    const json = JSON.stringify(content);
    const hash = sha256hex(json);

    // Primary: Lighthouse.storage (free 2 GB, simple Bearer-token API).
    if (process.env.LIGHTHOUSE_API_KEY) {
        try {
            const buffer = Buffer.from(json, 'utf-8');
            const cid = await uploadToLighthouse(buffer, `enact-${hash.slice(0, 8)}.json`, 'application/json');
            if (cid) {
                cidMap.set(hash, cid);
                return { cid, hash };
            }
        } catch (e) {
            console.warn('[IPFS] Lighthouse JSON failed, falling back to Pinata:', e);
        }
    }

    // Fallback: legacy Pinata JWT.
    if (!config.pinataJwt) throw new Error('Neither LIGHTHOUSE_API_KEY nor PINATA_JWT set. Get a free key at lighthouse.storage');
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.pinataJwt}`,
        },
        body: JSON.stringify({
            pinataContent: content,
            pinataMetadata: { name: `enact-${hash.slice(0, 8)}`, keyvalues: { descHash: hash } },
        }),
    });
    if (!res.ok) throw new Error(`Pinata upload failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { IpfsHash: string };
    return { cid: data.IpfsHash, hash };
}

async function uploadFileToIPFS(filePath: string): Promise<{ cid: string; hash: string; filename: string; mimeType: string; size: number }> {
    const fs = await import('fs');
    const path = await import('path');
    const fileBuffer = fs.readFileSync(filePath);
    const hash = createHash('sha256').update(fileBuffer).digest('hex');
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
        '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
        '.zip': 'application/zip', '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const size = fileBuffer.length;

    // Primary: Lighthouse.storage.
    if (process.env.LIGHTHOUSE_API_KEY) {
        try {
            const cid = await uploadToLighthouse(fileBuffer, filename, mimeType);
            if (cid) {
                cidMap.set(hash, cid);
                return { cid, hash, filename, mimeType, size };
            }
        } catch (e) {
            console.warn('[IPFS] Lighthouse file failed, falling back to Pinata:', e);
        }
    }

    // Fallback: legacy Pinata.
    if (!config.pinataJwt) throw new Error('Neither LIGHTHOUSE_API_KEY nor PINATA_JWT set');
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), filename);
    formData.append('pinataMetadata', JSON.stringify({
        name: `enact-file-${hash.slice(0, 8)}`,
        keyvalues: { descHash: hash, type: 'file', filename, mimeType, size: String(size) },
    }));

    const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.pinataJwt}` },
        body: formData,
    });
    if (!res.ok) throw new Error(`Pinata file upload failed: ${res.status}`);
    const data = await res.json() as { IpfsHash: string };
    cidMap.set(hash, data.IpfsHash);
    return { cid: data.IpfsHash, hash, filename, mimeType, size };
}

const IPFS_GW = process.env.IPFS_GATEWAY || process.env.PINATA_GATEWAY || 'https://ipfs.io/ipfs';

async function fetchFromIPFS(cid: string): Promise<any> {
    const res = await fetch(`${IPFS_GW}/${cid}`);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status}`);
    return res.json();
}

// Local CID mapping (hash → CID) for reverse lookup
const cidMap = new Map<string, string>();

/** Resolve IPFS CID from hash: check local cache, then Pinata metadata search */
async function resolveCID(hash: string): Promise<string | null> {
    if (!hash || hash === '0'.repeat(64)) return null;
    // 1. Local cache
    const cached = cidMap.get(hash);
    if (cached) return cached;
    // 2. Pinata metadata search
    if (!config.pinataJwt) return null;
    try {
        const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${config.pinataJwt}` },
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
            if (pins.rows?.length > 0) {
                const cid = pins.rows[0].ipfs_pin_hash;
                cidMap.set(hash, cid); // cache for next time
                return cid;
            }
        }
    } catch {}
    return null;
}

/** Check Pinata metadata to see if a hash corresponds to a file upload */
async function resolveFileMeta(hash: string): Promise<{ type: string; filename: string; mimeType: string; size: number } | null> {
    if (!config.pinataJwt) return null;
    try {
        const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"},"type":{"value":"file","op":"eq"}}`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${config.pinataJwt}` },
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const pins = await res.json() as { rows: Array<{ metadata: { keyvalues: Record<string, string> } }> };
            if (pins.rows?.length > 0) {
                const kv = pins.rows[0].metadata?.keyvalues;
                if (kv?.type === 'file') {
                    return { type: 'file', filename: kv.filename || 'unknown', mimeType: kv.mimeType || 'application/octet-stream', size: parseInt(kv.size || '0') };
                }
            }
        }
    } catch {}
    return null;
}

function createServer() {
    return new McpServer({
        name: 'enact-protocol',
        version: '2.0.0',
    });
}

/**
 * For stateless MCP clients (claude.ai's remote MCP integration fires
 * tools/call directly without echoing Mcp-Session-Id, so configure_agentic_wallet
 * cannot persist across calls). Each transaction tool also accepts the
 * operator credentials inline; when both are present we build a one-shot
 * AgenticState that overrides the session-bound one for THIS call only.
 * Stateful clients (any MCP client that follows the initialize handshake)
 * can still call configure_agentic_wallet once and omit these params.
 */
const AGENTIC_INLINE_SCHEMA = {
    agentic_secret_key: z.string().nullable().optional().describe('Optional. Hex 64-byte ed25519 operator secret key. Pass alongside agentic_wallet_address to sign this single call through the agentic wallet — useful for stateless MCP clients (e.g. claude.ai remote MCP) where configure_agentic_wallet does not persist between calls. If omitted, falls back to the wallet configured for this session.'),
    agentic_wallet_address: z.string().nullable().optional().describe('Optional. Agentic wallet address — required when agentic_secret_key is provided.'),
};
function buildInlineAgentic(args: { agentic_secret_key?: string | null; agentic_wallet_address?: string | null }, fallback: AgenticState): AgenticState {
    if (args.agentic_secret_key && args.agentic_wallet_address) {
        const sk = Buffer.from(args.agentic_secret_key.trim(), 'hex');
        if (sk.length !== 64) throw new Error('agentic_secret_key must be 64 bytes (128 hex chars)');
        return { operatorSecretKey: sk, walletAddress: Address.parse(args.agentic_wallet_address) };
    }
    return fallback;
}

function registerTools(server: McpServer, agentic: AgenticState) {

// ===== TOOLS =====

server.tool(
    'create_job',
    'Create a new job for an AI agent to complete. Description is uploaded to IPFS, hash stored on-chain.',
    {
        evaluator_address: z.string().describe('TON address of the evaluator'),
        budget_ton: z.string().describe('Budget in TON (e.g. "5"), or "0" for setBudget later'),
        description: z.string().describe('Full job description text. Will be uploaded to IPFS.'),
        file_path: z.string().optional().describe('Optional: path to a file to attach to the job description'),
        timeout_seconds: z.number().default(86400).describe('Timeout in seconds (default 24h, range 1h–30d)'),
        evaluation_timeout_seconds: z.number().default(86400).describe('Evaluation timeout for auto-claim (default 24h)'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ evaluator_address, budget_ton, description, file_path, timeout_seconds, evaluation_timeout_seconds, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        if (!config.factoryAddress) throw new Error('FACTORY_ADDRESS not set');

        let cid: string, hash: string;
        let fileInfo: any = null;
        if (file_path) {
            const f = await uploadFileToIPFS(file_path);
            fileInfo = { filename: f.filename, mimeType: f.mimeType, size: f.size, ipfsUrl: `${IPFS_GW}/${f.cid}` };
            // JSON with text + file reference → hash goes to contract
            const descResult = await uploadToIPFS({ type: 'job_description', description, file: { cid: f.cid, ...fileInfo }, createdAt: new Date().toISOString() });
            cid = descResult.cid; hash = descResult.hash;
        } else {
            const result = await uploadToIPFS({ type: 'job_description', description, createdAt: new Date().toISOString() });
            cid = result.cid; hash = result.hash;
        }
        cidMap.set(hash, cid);

        const body = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(Address.parse(evaluator_address))
            .storeCoins(toNano(budget_ton))
            .storeUint(BigInt('0x' + hash), 256)
            .storeUint(timeout_seconds, 32)
            .storeUint(evaluation_timeout_seconds, 32)
            .endCell();

        const result = await sendTransaction(eff, config.factoryAddress, toNano('0.03'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, ipfs_cid: cid, description_hash: hash, ...(fileInfo ? { file: fileInfo } : {}) }) }] };
    }
);

server.tool(
    'fund_job',
    'Fund a job by sending TON to the job contract address.',
    {
        job_address: z.string().describe('Job contract address'),
        amount_ton: z.string().describe('Amount in TON to send as payment'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, amount_ton, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const total = toNano(amount_ton) + toNano('0.01');
        const result = await sendTransaction(eff, Address.parse(job_address), total, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'take_job',
    'Take a job as a provider. Registers your wallet as the job provider.',
    {
        job_address: z.string().describe('Job contract address'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'submit_result',
    'Submit a result for a job you have taken. Result text or file is uploaded to IPFS, hash stored on-chain. Set encrypted=true for E2E encryption (only client and evaluator can decrypt).',
    {
        job_address: z.string().describe('Job contract address'),
        result_text: z.string().describe('Full result text. Will be uploaded to IPFS.'),
        file_path: z.string().optional().describe('Optional: path to a file to submit as result (image, document, etc.)'),
        encrypted: z.boolean().default(false).describe('If true, encrypt the result so only client and evaluator can read it'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, result_text, file_path, encrypted, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        let cid: string, hash: string;
        let fileInfo: any = null;

        if (encrypted) {
            if (!keyPair) throw new Error('Encryption requires a wallet (WALLET_MNEMONIC must be set)');
            // Read client and evaluator public keys from on-chain
            const addr = Address.parse(job_address);
            const jobData = await client.runMethod(addr, 'get_job_data');
            jobData.stack.readNumber(); // jobId
            const clientAddr = jobData.stack.readAddress();
            jobData.stack.readAddressOpt(); // provider
            const evaluatorAddr = jobData.stack.readAddress();

            const clientPubKey = await getWalletPublicKey(clientAddr.toString());
            const evaluatorPubKey = await getWalletPublicKey(evaluatorAddr.toString());

            // Build plaintext (with file if present)
            let plaintext = result_text;
            if (file_path) {
                const f = await uploadFileToIPFS(file_path);
                fileInfo = { filename: f.filename, mimeType: f.mimeType, size: f.size, ipfsUrl: `${IPFS_GW}/${f.cid}` };
                plaintext = JSON.stringify({ result: result_text, file: { cid: f.cid, ...fileInfo } });
            }

            const envelope = encryptResult(plaintext, keyPair.secretKey, keyPair.publicKey, { client: clientPubKey, evaluator: evaluatorPubKey });
            const uploaded = await uploadToIPFS(envelope);
            cid = uploaded.cid; hash = uploaded.hash;
        } else if (file_path) {
            const f = await uploadFileToIPFS(file_path);
            fileInfo = { filename: f.filename, mimeType: f.mimeType, size: f.size, ipfsUrl: `${IPFS_GW}/${f.cid}` };
            const textResult = await uploadToIPFS({ type: 'job_result', result: result_text, file: { cid: f.cid, ...fileInfo }, submittedAt: new Date().toISOString() });
            cid = textResult.cid; hash = textResult.hash;
        } else {
            const uploaded = await uploadToIPFS({ type: 'job_result', result: result_text, submittedAt: new Date().toISOString() });
            cid = uploaded.cid; hash = uploaded.hash;
        }
        cidMap.set(hash, cid);

        const body = beginCell()
            .storeUint(JobOpcodes.submitResult, 32)
            .storeUint(BigInt('0x' + hash), 256)
            .storeUint(2, 8) // result_type = 2 (IPFS)
            .endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, ipfs_cid: cid, result_hash: hash, encrypted, ...(fileInfo ? { file: fileInfo } : {}) }) }] };
    }
);

server.tool(
    'evaluate_job',
    'Evaluate a submitted job result. Approve sends funds to provider, reject refunds client.',
    {
        job_address: z.string().describe('Job contract address'),
        approved: z.boolean().describe('true to approve (pay provider), false to reject (refund client)'),
        reason: z.string().optional().describe('Optional reason hash (hex, 64 chars)'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, approved, reason, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const reasonInt = reason ? BigInt('0x' + reason) : 0n;
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(reasonInt, 256)
            .endCell();
        // 0.06 TON needed for USDT payout gas. For TON jobs excess returns immediately.
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'cancel_job',
    'Cancel a funded job after timeout expires. Refunds client.',
    {
        job_address: z.string().describe('Job contract address'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'claim_job',
    'Provider claims funds after evaluation timeout expires. Use when evaluator is silent.',
    {
        job_address: z.string().describe('Job contract address'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'quit_job',
    'Provider quits a job before submitting result. Job returns to open for another provider.',
    {
        job_address: z.string().describe('Job contract address'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell().storeUint(JobOpcodes.quit, 32).endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'decrypt_result',
    'Decrypt an encrypted job result. Only works if your wallet is the client or evaluator of the job.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        if (!keyPair) throw new Error('Decryption requires a wallet (WALLET_MNEMONIC must be set)');

        const addr = Address.parse(job_address);
        const jobData = await client.runMethod(addr, 'get_job_data');
        const jobId = jobData.stack.readNumber();
        const clientAddr = jobData.stack.readAddress();
        jobData.stack.readAddressOpt(); // provider
        const evaluatorAddr = jobData.stack.readAddress();
        jobData.stack.readBigNumber(); // budget
        jobData.stack.readBigNumber(); // descHash
        const resultHash = jobData.stack.readBigNumber();

        if (resultHash === 0n) throw new Error('No result submitted yet');

        const resultHashHex = resultHash.toString(16).padStart(64, '0');
        const resCid = await resolveCID(resultHashHex);
        if (!resCid) throw new Error('Could not resolve IPFS CID for result hash');

        const envelope = await fetchFromIPFS(resCid) as EncryptedEnvelope;
        if (envelope.type !== 'job_result_encrypted') {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Result is not encrypted', content: envelope }) }] };
        }

        // Determine role
        const myAddr = wallet!.address.toString();
        let role: 'client' | 'evaluator';
        if (myAddr === clientAddr.toString()) role = 'client';
        else if (myAddr === evaluatorAddr.toString()) role = 'evaluator';
        else throw new Error('Your wallet is neither client nor evaluator of this job');

        const decrypted = decryptResultEnvelope(envelope, role, keyPair.secretKey);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, role, decrypted_result: decrypted }) }] };
    }
);

server.tool(
    'set_budget',
    'Set or update the budget for a job in OPEN state. Only client can call.',
    {
        job_address: z.string().describe('Job contract address'),
        budget_ton: z.string().describe('Budget in TON'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, budget_ton, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const body = beginCell()
            .storeUint(JobOpcodes.setBudget, 32)
            .storeCoins(toNano(budget_ton))
            .endCell();
        const result = await sendTransaction(eff, Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'get_job_status',
    'Get the current status and data of a job contract.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        const stateNames = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

        // Try Supabase first (0 RPS)
        try {
            const sbUrl = process.env.SUPABASE_URL;
            const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
            if (sbUrl && sbKey) {
                const { createClient: sc } = await import('@supabase/supabase-js');
                const sb = sc(sbUrl, sbKey);
                const { data: j } = await sb.from('jobs').select('*').eq('address', job_address).single();
                if (j) {
                    const data: any = {
                        jobId: j.job_id, state: j.state_name, stateCode: j.state,
                        client: j.client, provider: j.provider, evaluator: j.evaluator,
                        budget: String(j.budget), descriptionHash: j.desc_hash,
                        description: j.description_text,
                        ...(j.description_file_cid ? { descriptionFile: { type: 'file', filename: j.description_file_name, ipfsUrl: `${IPFS_GW}/${j.description_file_cid}` } } : {}),
                        resultHash: j.result_hash, resultContent: j.result_encrypted ? '🔒 E2E Encrypted (use decrypt_result to read)' : j.result_text,
                        result_encrypted: j.result_encrypted ?? false,
                        ...(j.result_file_cid ? { resultFile: { type: 'file', filename: j.result_file_name, ipfsUrl: `${IPFS_GW}/${j.result_file_cid}` } } : {}),
                        resultType: ['hash', 'ton_storage', 'ipfs'][j.result_type] ?? 'unknown',
                        timeout: j.timeout, createdAt: j.created_at, evaluationTimeout: j.eval_timeout,
                        submittedAt: j.submitted_at, reason: j.reason_text || '0',
                    };
                    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
                }
            }
        } catch {}

        // Fallback to RPC
        const addr = Address.parse(job_address);
        try {
            const result = await client.runMethod(addr, 'get_job_data');
            const jobId = result.stack.readNumber();
            const clientAddr = result.stack.readAddress();
            const providerAddr = result.stack.readAddressOpt();
            const evaluatorAddr = result.stack.readAddress();
            const budget = result.stack.readBigNumber();
            const descHash = result.stack.readBigNumber();
            const resultHash = result.stack.readBigNumber();
            const timeout = result.stack.readNumber();
            const createdAt = result.stack.readNumber();
            const evalTimeout = result.stack.readNumber();
            const submittedAt = result.stack.readNumber();
            const resultType = result.stack.readNumber();
            const reason = result.stack.readBigNumber();
            const state = result.stack.readNumber();

            const resultTypeNames = ['hash', 'ton_storage', 'ipfs'];
            const descHashHex = descHash.toString(16).padStart(64, '0');
            const resultHashHex = resultHash.toString(16).padStart(64, '0');

            // Resolve description (text or file)
            let description: string | null = null;
            let descriptionFile: any = null;
            const descCid = await resolveCID(descHashHex);
            if (descCid) {
                try {
                    // Check Pinata metadata for file type
                    const pinMeta = await resolveFileMeta(descHashHex);
                    if (pinMeta) {
                        descriptionFile = { ...pinMeta, ipfsUrl: `${IPFS_GW}/${descCid}` };
                    }
                    const content = await fetchFromIPFS(descCid);
                    description = content.description ?? (typeof content === 'string' ? content : JSON.stringify(content));
                } catch { /* IPFS fetch failed */ }
            }

            // Resolve result (text or file)
            let resultContent: string | null = null;
            let resultFile: any = null;
            let resultEncrypted = false;
            if (resultHash > 0n) {
                const resCid = await resolveCID(resultHashHex);
                if (resCid) {
                    try {
                        const pinMeta = await resolveFileMeta(resultHashHex);
                        if (pinMeta) {
                            resultFile = { ...pinMeta, ipfsUrl: `${IPFS_GW}/${resCid}` };
                        }
                        const content = await fetchFromIPFS(resCid);
                        if (content?.type === 'job_result_encrypted') {
                            resultEncrypted = true;
                            resultContent = '🔒 E2E Encrypted (use decrypt_result to read)';
                        } else {
                            resultContent = content.result ?? (typeof content === 'string' ? content : JSON.stringify(content));
                        }
                    } catch { /* IPFS fetch failed */ }
                }
            }

            const data: any = {
                jobId,
                state: stateNames[state] ?? `UNKNOWN(${state})`,
                stateCode: state,
                client: clientAddr.toString(),
                provider: providerAddr?.toString() ?? null,
                evaluator: evaluatorAddr.toString(),
                budget: budget.toString(),
                descriptionHash: descHashHex,
                description,
                ...(descriptionFile ? { descriptionFile } : {}),
                resultHash: resultHashHex,
                resultContent,
                result_encrypted: resultEncrypted,
                ...(resultFile ? { resultFile } : {}),
                resultType: resultTypeNames[resultType] ?? `unknown(${resultType})`,
                timeout,
                createdAt,
                evaluationTimeout: evalTimeout,
                submittedAt,
                reason: reason.toString(16),
            };

            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

server.tool(
    'list_jobs',
    'List jobs created by the factory.',
    {
        factory_address: z.string().optional().describe('Factory address (uses env FACTORY_ADDRESS if not provided)'),
        from_id: z.number().default(0).describe('Start job ID'),
        count: z.number().default(10).describe('Number of jobs to list'),
    },
    async ({ factory_address, from_id, count }) => {
        const factoryAddr = factory_address || config.factoryAddress?.toString() || '';

        // Try Supabase first
        try {
            const sbUrl = process.env.SUPABASE_URL;
            const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
            if (sbUrl && sbKey) {
                const { createClient: sc } = await import('@supabase/supabase-js');
                const sb = sc(sbUrl, sbKey);
                const { data: jobs } = await sb.from('jobs')
                    .select('job_id, address')
                    .eq('factory_address', factoryAddr)
                    .gte('job_id', from_id)
                    .lt('job_id', from_id + count)
                    .order('job_id', { ascending: true });
                const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factoryAddr).single();
                if (jobs) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ totalJobs: state?.last_job_count ?? jobs.length, jobs: jobs.map((j: any) => ({ jobId: j.job_id, address: j.address })) }, null, 2) }] };
                }
            }
        } catch {}

        // Fallback to RPC
        const addr = factoryAddr ? Address.parse(factoryAddr) : config.factoryAddress;
        if (!addr) throw new Error('No factory address');
        const nextIdResult = await client.runMethod(addr, 'get_next_job_id');
        const nextId = nextIdResult.stack.readNumber();
        const jobs: any[] = [];
        const end = Math.min(from_id + count, nextId);
        for (let i = from_id; i < end; i++) {
            const addrResult = await client.runMethod(addr, 'get_job_address', [{ type: 'int', value: BigInt(i) }]);
            jobs.push({ jobId: i, address: addrResult.stack.readAddress().toString() });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ totalJobs: nextId, jobs }, null, 2) }] };
    }
);

// ===== JETTON JOB TOOLS =====

server.tool(
    'create_jetton_job',
    'Create a new USDT job. In local mode auto-sets USDT wallet. In remote mode call set_jetton_wallet after, then fund_jetton_job.',
    {
        evaluator_address: z.string().describe('TON address of the evaluator'),
        budget_usdt: z.string().describe('Budget in USDT (e.g. "5" for 5 USDT)'),
        description: z.string().describe('Full job description text. Will be uploaded to IPFS.'),
        timeout_seconds: z.number().default(86400).describe('Timeout in seconds (default 24h, range 1h–30d)'),
        evaluation_timeout_seconds: z.number().default(86400).describe('Evaluation timeout (default 24h)'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ evaluator_address, budget_usdt, description, timeout_seconds, evaluation_timeout_seconds, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
        const { cid, hash } = await uploadToIPFS({ type: 'jetton_job_description', description, createdAt: new Date().toISOString() });
        cidMap.set(hash, cid);

        const body = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(Address.parse(evaluator_address))
            .storeCoins(BigInt(Math.round(parseFloat(budget_usdt) * 1e6))) // USDT: 6 decimals
            .storeUint(BigInt('0x' + hash), 256)
            .storeUint(timeout_seconds, 32)
            .storeUint(evaluation_timeout_seconds, 32)
            .endCell();

        const result = await sendTransaction(eff, config.jettonFactoryAddress, toNano('0.03'), body);

        // In local mode: auto-set USDT wallet after job creation
        let jettonWallet = '';
        if (wallet) {
            try {
                // Quick poll for job deployment (sub-second with Catchain 2.0)
                for (let r = 0; r < 10; r++) { await new Promise(ok => setTimeout(ok, 200)); try { await client.runMethod(config.jettonFactoryAddress, 'get_next_job_id'); break; } catch {} }
                const nextId = await client.runMethod(config.jettonFactoryAddress, 'get_next_job_id');
                const jobId = nextId.stack.readNumber() - 1;
                const jobAddrRes = await client.runMethod(config.jettonFactoryAddress, 'get_job_address', [{ type: 'int', value: BigInt(jobId) }]);
                const jobAddr = jobAddrRes.stack.readAddress();

                const jwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                    { type: 'slice', cell: beginCell().storeAddress(jobAddr).endCell() },
                ]);
                const jw = jwRes.stack.readAddress();
                jettonWallet = jw.toString();

                const setBody = beginCell().storeUint(JobOpcodes.setJettonWallet, 32).storeAddress(jw).endCell();
                await sendTransaction(eff, jobAddr, toNano('0.01'), setBody);
            } catch (e: any) {
                console.error('Auto set_jetton_wallet failed:', e.message);
            }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, type: 'usdt_job', ipfs_cid: cid, description_hash: hash, jetton_wallet: jettonWallet || 'call set_jetton_wallet manually' }) }] };
    }
);

server.tool(
    'set_jetton_wallet',
    'Set the USDT Jetton wallet for a Jetton job. Resolves automatically. Must be called before funding.',
    {
        job_address: z.string().describe('Jetton job contract address'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
        const jobAddr = Address.parse(job_address);
        const walletRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(jobAddr).endCell() },
        ]);
        const jettonWalletAddr = walletRes.stack.readAddress();

        const body = beginCell()
            .storeUint(JobOpcodes.setJettonWallet, 32)
            .storeAddress(jettonWalletAddr)
            .endCell();
        const result = await sendTransaction(eff, jobAddr, toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, jetton_wallet: jettonWalletAddr.toString() }) }] };
    }
);

server.tool(
    'fund_jetton_job',
    'Fund a USDT job by sending USDT to the job contract. Resolves client and USDT wallet automatically from on-chain data.',
    {
        job_address: z.string().describe('Jetton job contract address'),
        amount_usdt: z.string().describe('Amount in USDT (e.g. "10" for 10 USDT)'),
        ...AGENTIC_INLINE_SCHEMA,
    },
    async ({ job_address, amount_usdt, agentic_secret_key, agentic_wallet_address }) => {
        const eff = buildInlineAgentic({ agentic_secret_key, agentic_wallet_address }, agentic);
        const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
        const jobAddr = Address.parse(job_address);
        const usdtAmount = BigInt(Math.round(parseFloat(amount_usdt) * 1e6));

        // Get client address from job contract (funder is always the client)
        const jobData = await client.runMethod(jobAddr, 'get_job_data');
        jobData.stack.readNumber(); // jobId
        const clientAddr = jobData.stack.readAddress();
        const senderAddr = wallet ? wallet.address : clientAddr;

        // Resolve sender's USDT jetton wallet
        const senderWalletRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(senderAddr).endCell() },
        ]);
        const senderJettonWallet = senderWalletRes.stack.readAddress();

        // Build jetton transfer body
        const jettonBody = beginCell()
            .storeUint(0x0f8a7ea5, 32) // op: jetton transfer
            .storeUint(0, 64)           // query_id
            .storeCoins(usdtAmount)     // jetton amount
            .storeAddress(jobAddr)      // destination: job contract
            .storeAddress(senderAddr)   // response_destination
            .storeBit(false)            // no custom_payload
            .storeCoins(toNano('0.05')) // forward_ton_amount
            .storeBit(false)            // no forward_payload
            .endCell();

        const result = await sendTransaction(eff, senderJettonWallet, toNano('0.1'), jettonBody);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, usdt_amount: amount_usdt, sender_jetton_wallet: senderJettonWallet.toString() }) }] };
    }
);

server.tool(
    'list_jetton_jobs',
    'List USDT jobs created by the JettonJobFactory.',
    {
        from_id: z.number().default(0).describe('Start job ID'),
        count: z.number().default(10).describe('Number of jobs to list'),
    },
    async ({ from_id, count }) => {
        const addr = config.jettonFactoryAddress;
        const nextIdResult = await client.runMethod(addr, 'get_next_job_id');
        const nextId = nextIdResult.stack.readNumber();

        const jobs: any[] = [];
        const end = Math.min(from_id + count, nextId);

        for (let i = from_id; i < end; i++) {
            const addrResult = await client.runMethod(addr, 'get_job_address', [
                { type: 'int', value: BigInt(i) },
            ]);
            const jobAddr = addrResult.stack.readAddress();
            jobs.push({ jobId: i, address: jobAddr.toString(), type: 'jetton' });
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({ totalJettonJobs: nextId, jobs }, null, 2),
            }],
        };
    }
);

server.tool(
    'configure_agentic_wallet',
    'Switch the MCP signer to a TON Tech Agentic Wallet (split-key wallet v5 deployed as an SBT). After this call every subsequent transaction tool (create_job, take_job, submit_result, evaluate_job, cancel_job, claim_job, etc.) routes through the operator key instead of the configured mnemonic. Pass operator_secret_key=null to revert to the mnemonic-based signer.',
    {
        operator_secret_key: z.string().nullable().describe('Hex-encoded 64-byte ed25519 secret key (concatenation of seed + public key, as produced by @ton/crypto keyPairFromSeed). Pass null to clear.'),
        agentic_wallet_address: z.string().nullable().describe('Address of the deployed Agentic Wallet contract (EQ... or 0:...). Pass null to clear.'),
    },
    async ({ operator_secret_key, agentic_wallet_address }) => {
        if (operator_secret_key == null || agentic_wallet_address == null) {
            agentic.operatorSecretKey = undefined;
            agentic.walletAddress = undefined;
            agentic.nftIndex = undefined;
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, mode: 'mnemonic', message: 'Agentic wallet cleared — falling back to configured mnemonic.' }) }] };
        }
        const sk = Buffer.from(operator_secret_key.trim(), 'hex');
        if (sk.length !== 64) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'operator_secret_key must be 64 bytes (128 hex chars)' }) }] };
        }
        agentic.operatorSecretKey = sk;
        agentic.walletAddress = Address.parse(agentic_wallet_address);
        agentic.nftIndex = undefined; // re-fetch on next send
        return { content: [{ type: 'text' as const, text: JSON.stringify({
            ok: true,
            mode: 'agentic-wallet',
            walletAddress: agentic.walletAddress.toString(),
            note: 'All subsequent transaction tools in THIS session sign with the operator key. State is per-MCP-session: it does not leak to other users on the remote MCP and is wiped when this session closes. Use configure_agentic_wallet with null arguments to switch back to the mnemonic.',
        }) }] };
    }
);

server.tool(
    'detect_agentic_wallet',
    'Probe an address to determine whether it is a TON Tech Agentic Wallet. Calls get_nft_data, get_public_key, get_origin_public_key, get_authority_address, get_revoked_time on the contract. Returns isAgenticWallet=false if any method throws (= treat as a regular wallet). When true, includes ownerAddress, operatorPublicKey, originOperatorPublicKey, collectionAddress, nftItemIndex, revokedAt, isRevoked.',
    {
        address: z.string().describe('Address to probe (EQ... or 0:...).'),
    },
    async ({ address }) => {
        const result = await detectAgenticWalletMcp(address);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'generate_agent_keypair',
    'Generate a fresh ed25519 keypair to use as Agentic Wallet operator. Returns publicKey and secretKey (hex), plus a deeplink to agents.ton.org/create with the publicKey prefilled so the user can mint a new wallet on top of this operator key. The secretKey must be stored securely — anyone with it can spend from the wallet within the operator scope.',
    {
        agent_name: z.string().optional().describe('Optional human-readable name for the agent. Used in the agents.ton.org deeplink.'),
    },
    async ({ agent_name }) => {
        const kp = keyPairFromSeed(randomBytes(32));
        const params = new URLSearchParams({ operatorPublicKey: kp.publicKey.toString('hex') });
        if (agent_name) params.set('name', agent_name);
        return { content: [{ type: 'text' as const, text: JSON.stringify({
            publicKey: kp.publicKey.toString('hex'),
            secretKey: kp.secretKey.toString('hex'),
            createDeeplink: `https://agents.ton.org/create?${params.toString()}`,
            warning: 'Store the secretKey securely. Anyone with this key can sign transactions on the wallet within the operator scope. The owner of the SBT can revoke this operator key at any time on agents.ton.org.',
        }) }] };
    }
);

}

// ===== START =====

async function main() {
    await init();
    const port = process.env.PORT;

    if (port) {
        // HTTP mode — multi-tenant remote deployment (Railway, etc.).
        // Each MCP client gets its own session ID; the agentic-wallet state
        // is closed-over per session, so configure_agentic_wallet only
        // affects the calling client and is GC'd when the session closes.
        const app = express();
        // Force HTTPS for the lifetime of the Mcp-Session-Id cookie/header
        // so a downgrade attack on a public Wi-Fi can't strip TLS and
        // hijack an active session id. Browsers and well-behaved MCP
        // clients pin the host to HTTPS for a year after their first hit.
        app.use((_req, res, next) => {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            next();
        });
        app.use(express.json());
        app.use(express.static('public'));

        // sessionId -> transport. Populated after a client completes the
        // MCP `initialize` handshake (StreamableHTTP session protocol).
        const transports: Record<string, StreamableHTTPServerTransport> = {};

        const isInitializeBody = (body: any) => {
            const items = Array.isArray(body) ? body : [body];
            return items.some(b => b && typeof b === 'object' && b.method === 'initialize');
        };

        app.post('/mcp', async (req, res) => {
            try {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;

                // 1. Existing session — reuse its server + AgenticState.
                if (sessionId && transports[sessionId]) {
                    await transports[sessionId].handleRequest(req, res, req.body);
                    return;
                }

                // 2. Initialize handshake — start a stateful session and
                //    register an Mcp-Session-Id with the client.
                if (!sessionId && isInitializeBody(req.body)) {
                    const agenticState: AgenticState = {};
                    const server = createServer();
                    registerTools(server, agenticState);
                    const transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (newSid) => { transports[newSid] = transport; },
                    });
                    transport.onclose = () => {
                        if (transport.sessionId) delete transports[transport.sessionId];
                        agenticState.operatorSecretKey?.fill(0);
                        agenticState.operatorSecretKey = undefined;
                        agenticState.walletAddress = undefined;
                        agenticState.nftIndex = undefined;
                        server.close().catch(() => {});
                    };
                    await server.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                    return;
                }

                // 3. Stateless one-off (clients that skip `initialize` and
                //    fire tools/list / tools/call directly, e.g. Claude.ai's
                //    remote MCP client). Build a fresh server with its own
                //    AgenticState, run the request, dispose. configure_agentic_wallet
                //    has no effect across stateless calls because each is a
                //    new server — callers that need persistent agentic
                //    signing should follow the initialize handshake above.
                const agenticState: AgenticState = {};
                const server = createServer();
                registerTools(server, agenticState);
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                res.on('close', () => {
                    agenticState.operatorSecretKey?.fill(0);
                    agenticState.operatorSecretKey = undefined;
                    transport.close();
                    server.close().catch(() => {});
                });
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('[MCP] /mcp handler:', error);
                if (!res.headersSent) {
                    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
                }
            }
        });

        // GET / DELETE on /mcp drive the SSE / disconnect side of the
        // streamable transport for stateful sessions — route them through
        // the existing per-session transport so client-initiated disconnects
        // close the session (and wipe its agentic state) immediately.
        const handleSessionRoutedRequest = async (req: express.Request, res: express.Response) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !transports[sessionId]) {
                res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session ID' }, id: null });
                return;
            }
            await transports[sessionId].handleRequest(req, res);
        };
        app.get('/mcp', handleSessionRoutedRequest);
        app.delete('/mcp', handleSessionRoutedRequest);

        app.get('/', (_req, res) => {
            res.json({ name: 'enact-protocol', version: '2.0.0', endpoint: '/mcp' });
        });

        app.listen(Number(port), '0.0.0.0', () => {
            console.log(`ENACT MCP server listening on port ${port}`);
        });
    } else {
        // Stdio mode — single-user local server (Claude Code, Cursor, etc.).
        // One AgenticState for the lifetime of the process; restart wipes it.
        const server = createServer();
        const agenticState: AgenticState = {};
        registerTools(server, agenticState);
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

main().catch(console.error);
