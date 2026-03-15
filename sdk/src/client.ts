import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

const FACTORY_ADDRESS = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY_ADDRESS = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

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

export class EnactClient {
    private client: TonClient;
    readonly factoryAddress: string;
    readonly jettonFactoryAddress: string;

    constructor(options?: { endpoint?: string; apiKey?: string; factoryAddress?: string; jettonFactoryAddress?: string }) {
        this.client = new TonClient({
            endpoint: options?.endpoint ?? 'https://toncenter.com/api/v2/jsonRPC',
            apiKey: options?.apiKey ?? '',
        });
        this.factoryAddress = options?.factoryAddress ?? FACTORY_ADDRESS;
        this.jettonFactoryAddress = options?.jettonFactoryAddress ?? JETTON_FACTORY_ADDRESS;
    }

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
            jobId,
            state,
            stateName: STATE_NAMES[state] ?? `UNKNOWN(${state})`,
            client: clientAddr.toString({ bounceable: false }),
            provider: providerAddr?.toString({ bounceable: false }) ?? null,
            evaluator: evaluatorAddr.toString({ bounceable: false }),
            budget,
            descHash: descHash.toString(16).padStart(64, '0'),
            resultHash: resultHash.toString(16).padStart(64, '0'),
            timeout,
            createdAt,
            evalTimeout,
            submittedAt,
            address: jobAddress,
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
