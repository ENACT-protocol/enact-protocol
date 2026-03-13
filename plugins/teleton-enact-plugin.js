/**
 * ENACT Protocol Plugin for Teleton Agent
 * https://github.com/TONresistor/teleton-agent
 *
 * Drop-in plugin that gives Teleton agents the ability to create,
 * take, and complete ENACT Protocol jobs autonomously.
 *
 * Installation:
 *   cp plugins/teleton-enact-plugin.js ~/.teleton/plugins/
 *   teleton start
 */

import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano } from '@ton/core';

const OPCODES = {
    createJob: 0x00000010,
    fund: 0x00000001,
    takeJob: 0x00000002,
    submitResult: 0x00000003,
    evaluate: 0x00000004,
    cancel: 0x00000005,
    claim: 0x00000007,
    quit: 0x00000008,
    setBudget: 0x00000009,
};

const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

async function getClient(context) {
    const endpoint = context.env?.TON_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC';
    const apiKey = context.env?.TONCENTER_API_KEY ?? '';
    return new TonClient({ endpoint, apiKey });
}

async function getWallet(context) {
    const client = await getClient(context);
    const mnemonic = (context.env?.WALLET_MNEMONIC ?? '').split(' ');
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    return { client, wallet, keyPair, contract: client.open(wallet) };
}

async function sendTx(context, to, value, body) {
    const { wallet, keyPair, contract } = await getWallet(context);
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to: Address.parse(to), value, body, bounce: true })],
    });
    return { seqno, wallet: wallet.address.toString() };
}

export const tools = [
    {
        name: 'enact_create_job',
        description: 'Create a new ENACT job with escrow. Use when you need to hire another agent for a task.',
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'What needs to be done' },
                budget_ton: { type: 'number', description: 'Budget in TON' },
                timeout_hours: { type: 'number', description: 'Hours before auto-cancel', default: 24 },
                eval_timeout_hours: { type: 'number', description: 'Hours before provider can auto-claim', default: 24 },
            },
            required: ['description', 'budget_ton'],
        },
        execute: async (params, context) => {
            const factoryAddress = context.env?.ENACT_FACTORY_ADDRESS;
            if (!factoryAddress) throw new Error('ENACT_FACTORY_ADDRESS not set');

            const { wallet } = await getWallet(context);
            const descHash = BigInt('0x' + Buffer.from(params.description).toString('hex').padEnd(64, '0').slice(0, 64));
            const timeout = (params.timeout_hours ?? 24) * 3600;
            const evalTimeout = (params.eval_timeout_hours ?? 24) * 3600;

            const body = beginCell()
                .storeUint(OPCODES.createJob, 32)
                .storeAddress(wallet.address) // evaluator = self
                .storeCoins(toNano(params.budget_ton.toString()))
                .storeUint(descHash, 256)
                .storeUint(timeout, 32)
                .storeUint(evalTimeout, 32)
                .endCell();

            const result = await sendTx(context, factoryAddress, toNano('0.03'), body);
            return { status: 'created', ...result };
        },
    },

    {
        name: 'enact_find_jobs',
        description: 'Find available ENACT jobs to take as provider. Use when looking for paid tasks.',
        parameters: {
            type: 'object',
            properties: {
                count: { type: 'number', description: 'How many recent jobs to check', default: 10 },
            },
        },
        execute: async (params, context) => {
            const factoryAddress = context.env?.ENACT_FACTORY_ADDRESS;
            if (!factoryAddress) throw new Error('ENACT_FACTORY_ADDRESS not set');

            const client = await getClient(context);
            const factoryAddr = Address.parse(factoryAddress);

            const nextIdResult = await client.runMethod(factoryAddr, 'get_next_job_id');
            const nextId = nextIdResult.stack.readNumber();
            const count = Math.min(params.count ?? 10, nextId);
            const jobs = [];

            for (let i = nextId - count; i < nextId; i++) {
                const addrResult = await client.runMethod(factoryAddr, 'get_job_address', [
                    { type: 'int', value: BigInt(i) },
                ]);
                const jobAddr = addrResult.stack.readAddress();

                try {
                    const dataResult = await client.runMethod(jobAddr, 'get_job_data');
                    const jobId = dataResult.stack.readNumber();
                    const clientAddr = dataResult.stack.readAddress();
                    const providerAddr = dataResult.stack.readAddressOpt();
                    const evaluatorAddr = dataResult.stack.readAddress();
                    const budget = dataResult.stack.readBigNumber();
                    // skip remaining fields
                    for (let j = 0; j < 9; j++) dataResult.stack.pop();
                    const state = dataResult.stack.readNumber();

                    jobs.push({
                        jobId: i,
                        address: jobAddr.toString(),
                        state: STATE_NAMES[state] ?? 'UNKNOWN',
                        budget: `${Number(budget) / 1e9} TON`,
                        hasProvider: providerAddr !== null,
                    });
                } catch {
                    jobs.push({ jobId: i, address: jobAddr.toString(), state: 'NOT_INITIALIZED' });
                }
            }

            return { totalJobs: nextId, jobs };
        },
    },

    {
        name: 'enact_take_job',
        description: 'Take an available ENACT job as provider.',
        parameters: {
            type: 'object',
            properties: {
                job_address: { type: 'string', description: 'Job contract address' },
            },
            required: ['job_address'],
        },
        execute: async (params, context) => {
            const body = beginCell().storeUint(OPCODES.takeJob, 32).endCell();
            return sendTx(context, params.job_address, toNano('0.01'), body);
        },
    },

    {
        name: 'enact_submit_result',
        description: 'Submit work result for a ENACT job you\'ve taken.',
        parameters: {
            type: 'object',
            properties: {
                job_address: { type: 'string', description: 'Job contract address' },
                result: { type: 'string', description: 'Result text or hash' },
                result_type: { type: 'number', description: '0=hash, 1=ton_storage, 2=ipfs', default: 0 },
            },
            required: ['job_address', 'result'],
        },
        execute: async (params, context) => {
            const resultHash = BigInt('0x' + Buffer.from(params.result).toString('hex').padEnd(64, '0').slice(0, 64));
            const body = beginCell()
                .storeUint(OPCODES.submitResult, 32)
                .storeUint(resultHash, 256)
                .storeUint(params.result_type ?? 0, 8)
                .endCell();
            return sendTx(context, params.job_address, toNano('0.01'), body);
        },
    },

    {
        name: 'enact_evaluate',
        description: 'Evaluate submitted work — approve to release payment, reject to refund.',
        parameters: {
            type: 'object',
            properties: {
                job_address: { type: 'string', description: 'Job contract address' },
                approved: { type: 'boolean', description: 'true=approve (pay), false=reject (refund)' },
                reason: { type: 'string', description: 'Optional reason text' },
            },
            required: ['job_address', 'approved'],
        },
        execute: async (params, context) => {
            const reasonHash = params.reason
                ? BigInt('0x' + Buffer.from(params.reason).toString('hex').padEnd(64, '0').slice(0, 64))
                : 0n;
            const body = beginCell()
                .storeUint(OPCODES.evaluate, 32)
                .storeUint(params.approved ? 1 : 0, 8)
                .storeUint(reasonHash, 256)
                .endCell();
            return sendTx(context, params.job_address, toNano('0.01'), body);
        },
    },

    {
        name: 'enact_job_status',
        description: 'Check the status of a ENACT job.',
        parameters: {
            type: 'object',
            properties: {
                job_address: { type: 'string', description: 'Job contract address' },
            },
            required: ['job_address'],
        },
        execute: async (params, context) => {
            const client = await getClient(context);
            const addr = Address.parse(params.job_address);
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

            return {
                jobId,
                state: STATE_NAMES[state] ?? 'UNKNOWN',
                budget: `${Number(budget) / 1e9} TON`,
                client: clientAddr.toString(),
                provider: providerAddr?.toString() ?? 'none',
                evaluator: evaluatorAddr.toString(),
                timeout: `${timeout / 3600}h`,
                evalTimeout: `${evalTimeout / 3600}h`,
                submittedAt,
                resultType: ['hash', 'ton_storage', 'ipfs'][resultType] ?? 'unknown',
            };
        },
    },
];
