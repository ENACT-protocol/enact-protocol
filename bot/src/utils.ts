import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, Cell, toNano } from '@ton/core';

const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

export const JobOpcodes = {
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

export const FactoryOpcodes = {
    createJob: 0x00000010,
};

export const FACTORY_ADDRESS = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
export const JETTON_FACTORY_ADDRESS = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

export function getStateName(state: number): string {
    return STATE_NAMES[state] ?? `UNKNOWN(${state})`;
}

let _client: TonClient | null = null;

export async function createClient() {
    if (_client) return _client;
    const endpoint = process.env.TON_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC';
    const apiKey = process.env.TONCENTER_API_KEY ?? '';
    _client = new TonClient({ endpoint, apiKey });
    return _client;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (e: any) {
            const is429 = e.message?.includes('429') || e.status === 429;
            if (is429 && i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                continue;
            }
            throw e;
        }
    }
    throw new Error('Max retries exceeded');
}

export async function createWalletFromMnemonic(client: TonClient, mnemonic: string[]) {
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    return { wallet, keyPair, contract: client.open(wallet) };
}

export async function sendTx(
    client: TonClient,
    wallet: { wallet: WalletContractV5R1; keyPair: any; contract: any },
    to: Address,
    value: bigint,
    body: Cell
) {
    const seqno = await withRetry(() => wallet.contract.getSeqno());
    await withRetry(() => wallet.contract.sendTransfer({
        seqno,
        secretKey: wallet.keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to, value, body, bounce: true })],
    }));
    return seqno;
}

// ─── Supabase singleton ───
let _supabase: any = null;
async function getSb() {
    if (_supabase) return _supabase;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
    const { createClient: sc } = await import('@supabase/supabase-js');
    _supabase = sc(url, key);
    return _supabase;
}

// ─── Read from Supabase first, RPC fallback ───

export async function getJobStatus(client: TonClient, jobAddress: string) {
    // Try Supabase first (0 RPS)
    try {
        const sb = await getSb();
        if (sb) {
            const { data } = await sb.from('jobs').select('*').eq('address', jobAddress).single();
            if (data) {
                return {
                    jobId: data.job_id, state: data.state, stateName: data.state_name,
                    client: data.client, provider: data.provider ?? 'none', evaluator: data.evaluator,
                    budget: BigInt(data.budget), descHash: data.desc_hash, resultHash: data.result_hash,
                    timeout: data.timeout, createdAt: data.created_at, evalTimeout: data.eval_timeout,
                    submittedAt: data.submitted_at, resultType: data.result_type,
                    reason: '0', reasonHash: '0'.repeat(64),
                };
            }
        }
    } catch {}
    // Fallback to RPC
    const addr = Address.parse(jobAddress);
    const result = await withRetry(() => client.runMethod(addr, 'get_job_data'));
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
    const uf = { bounceable: false };
    return {
        jobId, state, stateName: getStateName(state),
        client: clientAddr.toString(uf), provider: providerAddr?.toString(uf) ?? 'none',
        evaluator: evaluatorAddr.toString(uf), budget,
        descHash: descHash.toString(16).padStart(64, '0'),
        resultHash: resultHash.toString(16).padStart(64, '0'),
        timeout, createdAt, evalTimeout, submittedAt, resultType,
        reason: reason.toString(), reasonHash: reason.toString(16).padStart(64, '0'),
    };
}

export async function getFactoryJobCount(client: TonClient, factoryAddress: string) {
    // Try Supabase first
    try {
        const sb = await getSb();
        if (sb) {
            const { data } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factoryAddress).single();
            if (data?.last_job_count != null) return data.last_job_count;
        }
    } catch {}
    // Fallback to RPC
    const addr = Address.parse(factoryAddress);
    const result = await withRetry(() => client.runMethod(addr, 'get_next_job_id'));
    return result.stack.readNumber();
}

export async function getJobAddress(client: TonClient, factoryAddress: string, jobId: number) {
    // Try Supabase first
    try {
        const sb = await getSb();
        if (sb) {
            const { data } = await sb.from('jobs').select('address').eq('factory_address', factoryAddress).eq('job_id', jobId).single();
            if (data?.address) return Address.parse(data.address);
        }
    } catch {}
    // Fallback to RPC
    const addr = Address.parse(factoryAddress);
    const result = await withRetry(() => client.runMethod(addr, 'get_job_address', [
        { type: 'int', value: BigInt(jobId) },
    ]));
    return result.stack.readAddress();
}

export function fmtTon(nanotons: bigint | string): string {
    try {
        const val = typeof nanotons === 'bigint' ? nanotons : BigInt(nanotons);
        return (Number(val) / 1e9).toFixed(2);
    } catch {
        return '0.00';
    }
}

export function fmtUsdt(units: bigint | string): string {
    try {
        const val = typeof units === 'bigint' ? units : BigInt(units);
        return (Number(val) / 1e6).toFixed(2);
    } catch {
        return '0.00';
    }
}

export function explorerLink(addr: string): string {
    return `https://www.enact.info/explorer/job/${addr}`;
}

export function explorerFactoryLink(addr: string): string {
    return `https://www.enact.info/explorer/factory/${addr}`;
}
