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

export const FACTORY_ADDRESS = 'EQBWzGqJmn5BpUPyWmLsEM5uBzTOUct-n0-uj-5-uAA89Hk5';
export const JETTON_FACTORY_ADDRESS = 'EQBD38Dc4Fplj18JuIoIS509rvyvC58gznj4ImgBqZcDPvTp';

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

export async function getJobStatus(client: TonClient, jobAddress: string) {
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
        client: clientAddr.toString(uf),
        provider: providerAddr?.toString(uf) ?? 'none',
        evaluator: evaluatorAddr.toString(uf),
        budget,
        descHash: descHash.toString(16).padStart(64, '0'),
        resultHash: resultHash.toString(16).padStart(64, '0'),
        timeout, createdAt, evalTimeout, submittedAt, resultType,
        reason: reason.toString(),
    };
}

export async function getFactoryJobCount(client: TonClient, factoryAddress: string) {
    const addr = Address.parse(factoryAddress);
    const result = await withRetry(() => client.runMethod(addr, 'get_next_job_id'));
    return result.stack.readNumber();
}

export async function getJobAddress(client: TonClient, factoryAddress: string, jobId: number) {
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

export function explorerLink(addr: string): string {
    return `https://tonscan.org/address/${addr}`;
}
