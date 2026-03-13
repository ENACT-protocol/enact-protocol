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
};

export const FactoryOpcodes = {
    createJob: 0x00000010,
};

export function getStateName(state: number): string {
    return STATE_NAMES[state] ?? `UNKNOWN(${state})`;
}

// Singleton client
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
                const delay = 1000 * (i + 1);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw e;
        }
    }
    throw new Error('Max retries exceeded');
}

export async function createWallet(client: TonClient) {
    const mnemonic = process.env.WALLET_MNEMONIC?.split(' ') ?? [];
    if (mnemonic.length === 0) throw new Error('WALLET_MNEMONIC not set');
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

    return {
        jobId, state, stateName: getStateName(state),
        client: clientAddr.toString(),
        provider: providerAddr?.toString() ?? 'none',
        evaluator: evaluatorAddr.toString(),
        budget: budget.toString(),
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
