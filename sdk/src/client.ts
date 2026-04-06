import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, Cell, toNano, SendMode, internal } from '@ton/core';
import { createHash } from 'crypto';
import { encryptResult, decryptResult as decryptEnvelope, EncryptedEnvelope } from './crypto';

const FACTORY_ADDRESS = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY_ADDRESS = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

const FactoryOp = { createJob: 0x00000010 };
const JobOp = {
    fund: 0x00000001, takeJob: 0x00000002, submitResult: 0x00000003,
    evaluate: 0x00000004, cancel: 0x00000005, claim: 0x00000007,
    quit: 0x00000008, setBudget: 0x00000009, setJettonWallet: 0x0000000a,
};

export interface JobData {
    jobId: number;
    state: number;
    stateName: string;
    client: string;
    provider: string | null;
    evaluator: string;
    budget: bigint;
    budgetTon: string;
    descHash: string;
    resultHash: string;
    reasonHash: string;
    timeout: number;
    createdAt: number;
    evalTimeout: number;
    submittedAt: number;
    address: string;
}

export interface JobListItem {
    jobId: number;
    address: string;
    type: 'ton' | 'usdt';
}

export interface CreateJobParams {
    description: string;
    budget: string;
    evaluator: string;
    timeout?: number;
    evalTimeout?: number;
    file?: { buffer: Buffer; filename: string };
}

interface WalletState {
    contract: WalletContractV5R1;
    secretKey: Buffer;
}

export class EnactClient {
    private client: TonClient;
    private walletPromise: Promise<WalletState> | null = null;
    private pinataJwt: string | null = null;
    readonly factoryAddress: string;
    readonly jettonFactoryAddress: string;

    constructor(options?: {
        endpoint?: string;
        apiKey?: string;
        mnemonic?: string;
        pinataJwt?: string;
        factoryAddress?: string;
        jettonFactoryAddress?: string;
    }) {
        this.client = new TonClient({
            endpoint: options?.endpoint ?? 'https://toncenter.com/api/v2/jsonRPC',
            apiKey: options?.apiKey ?? '',
        });
        this.factoryAddress = options?.factoryAddress ?? FACTORY_ADDRESS;
        this.jettonFactoryAddress = options?.jettonFactoryAddress ?? JETTON_FACTORY_ADDRESS;
        this.pinataJwt = options?.pinataJwt ?? null;

        if (options?.mnemonic) {
            this.walletPromise = this._initWallet(options.mnemonic);
        }
    }

    private async _initWallet(mnemonic: string): Promise<WalletState> {
        const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
        return {
            contract: WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 }),
            secretKey: keyPair.secretKey,
        };
    }

    private async _ensureWallet(): Promise<WalletState> {
        if (!this.walletPromise) throw new Error('Wallet not initialized. Pass mnemonic to constructor.');
        return this.walletPromise;
    }

    private async _send(to: Address, value: bigint, body: Cell) {
        const w = await this._ensureWallet();
        const opened = this.client.open(w.contract);
        const seqno = await opened.getSeqno();
        await opened.sendTransfer({
            seqno,
            secretKey: w.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to, value, body, bounce: true })],
        });
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 200));
            const newSeqno = await opened.getSeqno();
            if (newSeqno > seqno) return;
        }
        throw new Error('Transaction not confirmed after 4s');
    }

    private async _uploadToIPFS(content: object): Promise<bigint> {
        const json = JSON.stringify(content);
        const hash = createHash('sha256').update(json, 'utf-8').digest('hex');

        if (this.pinataJwt) {
            const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.pinataJwt}` },
                body: JSON.stringify({
                    pinataContent: content,
                    pinataMetadata: { name: `enact-${hash.slice(0, 8)}`, keyvalues: { descHash: hash } },
                }),
            });
            if (!res.ok) throw new Error(`IPFS upload failed: ${res.status}`);
        }

        return BigInt('0x' + hash);
    }

    private async _uploadFileToIPFS(buffer: Buffer, filename: string): Promise<{ hash: bigint; cid: string; filename: string; mimeType: string; size: number }> {
        if (!this.pinataJwt) throw new Error('pinataJwt required for file uploads');
        const hash = createHash('sha256').update(buffer).digest('hex');
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip' };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        const formData = new FormData();
        formData.append('file', new Blob([buffer], { type: mimeType }), filename);
        formData.append('pinataMetadata', JSON.stringify({
            name: `enact-file-${hash.slice(0, 8)}`,
            keyvalues: { descHash: hash, type: 'file', filename, mimeType, size: String(buffer.length) },
        }));

        const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.pinataJwt}` },
            body: formData,
        });
        if (!res.ok) throw new Error(`File upload failed: ${res.status}`);
        const data = await res.json() as { IpfsHash: string };
        return { hash: BigInt('0x' + hash), cid: data.IpfsHash, filename, mimeType, size: buffer.length };
    }

    /** Get wallet address (requires mnemonic) */
    async getWalletAddress(): Promise<string> {
        const w = await this._ensureWallet();
        return w.contract.address.toString({ bounceable: false });
    }

    // ─── Read Operations ───

    async listJobs(): Promise<JobListItem[]> {
        return this._listFromFactory(this.factoryAddress, 'ton');
    }

    async listJettonJobs(): Promise<JobListItem[]> {
        return this._listFromFactory(this.jettonFactoryAddress, 'usdt');
    }

    async getJobStatus(jobAddress: string): Promise<JobData> {
        const addr = Address.parse(jobAddress);
        const result = await this.client.runMethod(addr, 'get_job_data');

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
        result.stack.readNumber(); // resultType
        const reason = result.stack.readBigNumber();
        const state = result.stack.readNumber();

        return {
            jobId, state, stateName: STATE_NAMES[state] ?? `UNKNOWN(${state})`,
            client: clientAddr.toString({ bounceable: false }),
            provider: providerAddr?.toString({ bounceable: false }) ?? null,
            evaluator: evaluatorAddr.toString({ bounceable: false }),
            budget,
            budgetTon: (Number(budget) / 1e9).toFixed(4),
            descHash: descHash.toString(16).padStart(64, '0'),
            resultHash: resultHash.toString(16).padStart(64, '0'),
            reasonHash: reason.toString(16).padStart(64, '0'),
            timeout, createdAt, evalTimeout, submittedAt, address: jobAddress,
        };
    }

    async getJobCount(): Promise<number> {
        const result = await this.client.runMethod(Address.parse(this.factoryAddress), 'get_next_job_id');
        return result.stack.readNumber();
    }

    async getJettonJobCount(): Promise<number> {
        const result = await this.client.runMethod(Address.parse(this.jettonFactoryAddress), 'get_next_job_id');
        return result.stack.readNumber();
    }

    async getJobAddress(jobId: number, factory?: string): Promise<string> {
        const addr = Address.parse(factory ?? this.factoryAddress);
        const result = await this.client.runMethod(addr, 'get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        return result.stack.readAddress().toString();
    }

    // ─── TON Write Operations ───

    /** Create a TON job. Returns the job contract address. */
    async createJob(params: CreateJobParams): Promise<string> {
        const countBefore = await this.getJobCount();

        let descHash: bigint;
        if (params.file && this.pinataJwt) {
            const f = await this._uploadFileToIPFS(params.file.buffer, params.file.filename);
            // JSON with text + file reference → hash goes to contract
            descHash = await this._uploadToIPFS({
                type: 'job_description', description: params.description,
                file: { cid: f.cid, filename: f.filename, mimeType: f.mimeType, size: f.size },
                createdAt: new Date().toISOString(),
            });
        } else {
            descHash = await this._uploadToIPFS({
                type: 'job_description', description: params.description, createdAt: new Date().toISOString(),
            });
        }

        const body = beginCell()
            .storeUint(FactoryOp.createJob, 32)
            .storeAddress(Address.parse(params.evaluator))
            .storeCoins(toNano(params.budget))
            .storeUint(descHash, 256)
            .storeUint(params.timeout ?? 86400, 32)
            .storeUint(params.evalTimeout ?? params.timeout ?? 86400, 32)
            .endCell();

        await this._send(Address.parse(this.factoryAddress), toNano('0.03'), body);

        // Verify job was created
        const countAfter = await this.getJobCount();
        if (countAfter <= countBefore) throw new Error('Job creation not confirmed on-chain');
        return this.getJobAddress(countAfter - 1);
    }

    /** Fund a TON job (sends budget amount). */
    async fundJob(jobAddress: string): Promise<void> {
        const status = await this.getJobStatus(jobAddress);
        const body = beginCell().storeUint(JobOp.fund, 32).endCell();
        await this._send(Address.parse(jobAddress), status.budget + toNano('0.01'), body);
    }

    /** Take a job as provider. */
    async takeJob(jobAddress: string): Promise<void> {
        const body = beginCell().storeUint(JobOp.takeJob, 32).endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Submit a result for a job. Optionally attach a file. */
    async submitResult(jobAddress: string, result: string, file?: { buffer: Buffer; filename: string }): Promise<void> {
        let resultHash: bigint;
        if (file && this.pinataJwt) {
            const f = await this._uploadFileToIPFS(file.buffer, file.filename);
            // JSON with text + file reference → hash goes to contract
            resultHash = await this._uploadToIPFS({
                type: 'job_result', result,
                file: { cid: f.cid, filename: f.filename, mimeType: f.mimeType, size: f.size },
                submittedAt: new Date().toISOString(),
            });
        } else {
            resultHash = await this._uploadToIPFS({
                type: 'job_result', result, submittedAt: new Date().toISOString(),
            });
        }
        const body = beginCell()
            .storeUint(JobOp.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(0, 8) // resultType
            .endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /**
     * Submit an encrypted result. Only client and evaluator can decrypt.
     * Uses ed25519 → x25519 ECDH + AES-256-CBC. Contract unchanged.
     */
    async submitEncryptedResult(
        jobAddress: string,
        result: string,
        recipientPublicKeys: { client: Buffer; evaluator: Buffer },
        file?: { buffer: Buffer; filename: string },
    ): Promise<void> {
        const wallet = await this._ensureWallet();

        // Build result content (same as unencrypted)
        let resultContent: string = result;
        if (file && this.pinataJwt) {
            const f = await this._uploadFileToIPFS(file.buffer, file.filename);
            resultContent = JSON.stringify({
                result,
                file: { cid: f.cid, filename: f.filename, mimeType: f.mimeType, size: f.size },
            });
        }

        // Encrypt result for client + evaluator
        const senderPublicKey = wallet.secretKey.subarray(32); // last 32 bytes = public key
        const envelope = encryptResult(resultContent, wallet.secretKey, senderPublicKey, recipientPublicKeys);

        // Upload encrypted envelope to IPFS
        const resultHash = await this._uploadToIPFS(envelope);

        const body = beginCell()
            .storeUint(JobOp.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(1, 8) // resultType = 1 (encrypted)
            .endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /**
     * Decrypt an encrypted result from IPFS.
     * @param envelope - the encrypted envelope JSON from IPFS
     * @param role - 'client' or 'evaluator'
     */
    async decryptJobResult(
        envelope: EncryptedEnvelope,
        role: 'client' | 'evaluator',
    ): Promise<string> {
        const wallet = await this._ensureWallet();
        return decryptEnvelope(envelope, role, wallet.secretKey);
    }

    /**
     * Get the ed25519 public key from a TON wallet address (reads on-chain state).
     * Works for wallet V3R1, V3R2, V4R2, V5R1.
     */
    async getWalletPublicKey(address: string): Promise<Buffer> {
        const result = await this.client.runMethod(Address.parse(address), 'get_public_key');
        const pubKeyInt = result.stack.readBigNumber();
        return Buffer.from(pubKeyInt.toString(16).padStart(64, '0'), 'hex');
    }

    /** Evaluate a job (approve or reject). */
    async evaluateJob(jobAddress: string, approved: boolean, reason?: string): Promise<void> {
        let reasonHash: bigint;
        if (reason && this.pinataJwt) {
            reasonHash = await this._uploadToIPFS({
                type: 'evaluation_reason', reason, evaluatedAt: new Date().toISOString(),
            });
        } else if (reason) {
            reasonHash = BigInt('0x' + Buffer.from(reason).toString('hex').padEnd(64, '0').slice(0, 64));
        } else {
            reasonHash = 0n;
        }
        const body = beginCell()
            .storeUint(JobOp.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(reasonHash, 256)
            .endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Cancel a job after timeout. */
    async cancelJob(jobAddress: string): Promise<void> {
        const body = beginCell().storeUint(JobOp.cancel, 32).endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Claim payment after evaluation timeout. */
    async claimJob(jobAddress: string): Promise<void> {
        const body = beginCell().storeUint(JobOp.claim, 32).endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Quit a job before submitting. */
    async quitJob(jobAddress: string): Promise<void> {
        const body = beginCell().storeUint(JobOp.quit, 32).endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    // ─── Jetton (USDT) Write Operations ───

    /** Create a USDT job. Returns the job contract address. */
    async createJettonJob(params: CreateJobParams): Promise<string> {
        const countBefore = await this.getJettonJobCount();

        const descHash = await this._uploadToIPFS({
            type: 'job_description', description: params.description, createdAt: new Date().toISOString(),
        });

        const usdtBudget = BigInt(Math.round(parseFloat(params.budget) * 1e6));
        const body = beginCell()
            .storeUint(FactoryOp.createJob, 32)
            .storeAddress(Address.parse(params.evaluator))
            .storeCoins(usdtBudget)
            .storeUint(descHash, 256)
            .storeUint(params.timeout ?? 86400, 32)
            .storeUint(params.evalTimeout ?? params.timeout ?? 86400, 32)
            .endCell();

        await this._send(Address.parse(this.jettonFactoryAddress), toNano('0.03'), body);

        const countAfter = await this.getJettonJobCount();
        if (countAfter <= countBefore) throw new Error('Jetton job creation not confirmed on-chain');
        return this.getJobAddress(countAfter - 1, this.jettonFactoryAddress);
    }

    /** Set USDT wallet on a jetton job (auto-resolves wallet address). */
    async setJettonWallet(jobAddress: string): Promise<void> {
        const usdtMaster = Address.parse(USDT_MASTER);
        const result = await this.client.runMethod(usdtMaster, 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(Address.parse(jobAddress)).endCell() },
        ]);
        const jettonWallet = result.stack.readAddress();

        const body = beginCell()
            .storeUint(JobOp.setJettonWallet, 32)
            .storeAddress(jettonWallet)
            .endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Fund a USDT job (sends Jetton transfer). */
    async fundJettonJob(jobAddress: string): Promise<void> {
        const w = await this._ensureWallet();
        const status = await this.getJobStatus(jobAddress);

        const usdtMaster = Address.parse(USDT_MASTER);
        const walletResult = await this.client.runMethod(usdtMaster, 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(w.contract.address).endCell() },
        ]);
        const senderJettonWallet = walletResult.stack.readAddress();

        const forwardPayload = beginCell().storeUint(0, 32).endCell();
        const body = beginCell()
            .storeUint(0xf8a7ea5, 32)
            .storeUint(0, 64)
            .storeCoins(status.budget)
            .storeAddress(Address.parse(jobAddress))
            .storeAddress(w.contract.address)
            .storeBit(false)
            .storeCoins(toNano('0.05'))
            .storeBit(true)
            .storeRef(forwardPayload)
            .endCell();

        await this._send(senderJettonWallet, toNano('0.1'), body);
    }

    // ─── Private ───

    private async _listFromFactory(factory: string, type: 'ton' | 'usdt'): Promise<JobListItem[]> {
        const addr = Address.parse(factory);
        const countResult = await this.client.runMethod(addr, 'get_next_job_id');
        const count = countResult.stack.readNumber();

        const jobs: JobListItem[] = [];
        for (let i = 0; i < count; i++) {
            const addrResult = await this.client.runMethod(addr, 'get_job_address', [
                { type: 'int', value: BigInt(i) },
            ]);
            const jobAddr = addrResult.stack.readAddress().toString();
            jobs.push({ jobId: i, address: jobAddr, type });
        }
        return jobs;
    }
}
