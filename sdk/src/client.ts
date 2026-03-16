import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano, SendMode, internal } from '@ton/core';
import { createHash } from 'crypto';

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
    descHash: string;
    resultHash: string;
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
}

interface WalletState {
    contract: WalletContractV5R1;
    secretKey: Buffer;
}

export class EnactClient {
    private client: TonClient;
    private wallet: WalletState | null = null;
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
            this._initWallet(options.mnemonic);
        }
    }

    private async _initWallet(mnemonic: string) {
        const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
        this.wallet = {
            contract: WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 }),
            secretKey: keyPair.secretKey,
        };
    }

    private async _ensureWallet(): Promise<WalletState> {
        // Wait for async init to complete
        for (let i = 0; i < 20 && !this.wallet; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!this.wallet) throw new Error('Wallet not initialized. Pass mnemonic to constructor.');
        return this.wallet;
    }

    private async _send(to: Address, value: bigint, body: ReturnType<typeof beginCell>['endCell'] extends () => infer R ? R : never) {
        const w = await this._ensureWallet();
        const opened = this.client.open(w.contract);
        const seqno = await opened.getSeqno();
        await opened.sendTransfer({
            seqno,
            secretKey: w.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to, value, body, bounce: true })],
        });
        // Wait for confirmation
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const newSeqno = await opened.getSeqno();
            if (newSeqno > seqno) return;
        }
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
        result.stack.readBigNumber(); // reason
        const state = result.stack.readNumber();

        return {
            jobId, state, stateName: STATE_NAMES[state] ?? `UNKNOWN(${state})`,
            client: clientAddr.toString({ bounceable: false }),
            provider: providerAddr?.toString({ bounceable: false }) ?? null,
            evaluator: evaluatorAddr.toString({ bounceable: false }),
            budget, descHash: descHash.toString(16).padStart(64, '0'),
            resultHash: resultHash.toString(16).padStart(64, '0'),
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
        const descHash = await this._uploadToIPFS({
            type: 'job_description', description: params.description, createdAt: new Date().toISOString(),
        });

        const body = beginCell()
            .storeUint(FactoryOp.createJob, 32)
            .storeAddress(Address.parse(params.evaluator))
            .storeCoins(toNano(params.budget))
            .storeUint(descHash, 256)
            .storeUint(params.timeout ?? 86400, 32)
            .storeUint(params.evalTimeout ?? params.timeout ?? 86400, 32)
            .endCell();

        await this._send(Address.parse(this.factoryAddress), toNano('0.03'), body);

        // Resolve new job address
        const count = await this.getJobCount();
        return this.getJobAddress(count - 1);
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

    /** Submit a result for a job. */
    async submitResult(jobAddress: string, result: string): Promise<void> {
        const resultHash = await this._uploadToIPFS({
            type: 'job_result', result, submittedAt: new Date().toISOString(),
        });
        const body = beginCell()
            .storeUint(JobOp.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(0, 8) // resultType
            .endCell();
        await this._send(Address.parse(jobAddress), toNano('0.01'), body);
    }

    /** Evaluate a job (approve or reject). */
    async evaluateJob(jobAddress: string, approved: boolean, reason?: string): Promise<void> {
        const reasonHash = reason
            ? BigInt('0x' + Buffer.from(reason).toString('hex').padEnd(64, '0').slice(0, 64))
            : 0n;
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

        const count = await this.getJettonJobCount();
        return this.getJobAddress(count - 1, this.jettonFactoryAddress);
    }

    /** Set USDT wallet on a jetton job (auto-resolves wallet address). */
    async setJettonWallet(jobAddress: string): Promise<void> {
        // Resolve USDT wallet for the job contract
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

        // Resolve sender's USDT wallet
        const usdtMaster = Address.parse(USDT_MASTER);
        const walletResult = await this.client.runMethod(usdtMaster, 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(w.contract.address).endCell() },
        ]);
        const senderJettonWallet = walletResult.stack.readAddress();

        // Build Jetton transfer
        const forwardPayload = beginCell().storeUint(0, 32).endCell();
        const body = beginCell()
            .storeUint(0xf8a7ea5, 32) // transfer opcode
            .storeUint(0, 64) // query_id
            .storeCoins(status.budget) // amount
            .storeAddress(Address.parse(jobAddress)) // destination
            .storeAddress(w.contract.address) // response_destination
            .storeBit(false) // no custom_payload
            .storeCoins(toNano('0.05')) // forward_ton_amount
            .storeBit(true) // forward_payload as ref
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
