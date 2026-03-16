import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import { Address, beginCell, Cell, toNano, TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { config } from './config.js';

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

let client: TonClient;
let wallet: WalletContractV5R1 | undefined;
let keyPair: { publicKey: Buffer; secretKey: Buffer } | undefined;

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

async function sendTransaction(to: Address, value: bigint, body: Cell) {
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

// ─── IPFS via Pinata REST API ───

function sha256hex(text: string): string {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function uploadToIPFS(content: object): Promise<{ cid: string; hash: string }> {
    if (!config.pinataJwt) throw new Error('PINATA_JWT not set. Get key at pinata.cloud/keys');
    const json = JSON.stringify(content);
    const hash = sha256hex(json);

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

const IPFS_GW = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

async function fetchFromIPFS(cid: string): Promise<any> {
    const res = await fetch(`${IPFS_GW}/${cid}`);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status}`);
    return res.json();
}

// Local CID mapping (hash → CID) for reverse lookup
const cidMap = new Map<string, string>();

function createServer() {
    return new McpServer({
        name: 'enact-protocol',
        version: '2.0.0',
    });
}

function registerTools(server: McpServer) {

// ===== TOOLS =====

server.tool(
    'create_job',
    'Create a new job for an AI agent to complete. Description is uploaded to IPFS, hash stored on-chain.',
    {
        evaluator_address: z.string().describe('TON address of the evaluator'),
        budget_ton: z.string().describe('Budget in TON (e.g. "5"), or "0" for setBudget later'),
        description: z.string().describe('Full job description text. Will be uploaded to IPFS.'),
        timeout_seconds: z.number().default(86400).describe('Timeout in seconds (default 24h, range 1h–30d)'),
        evaluation_timeout_seconds: z.number().default(86400).describe('Evaluation timeout for auto-claim (default 24h)'),
    },
    async ({ evaluator_address, budget_ton, description, timeout_seconds, evaluation_timeout_seconds }) => {
        if (!config.factoryAddress) throw new Error('FACTORY_ADDRESS not set');

        // Upload description to IPFS
        const { cid, hash } = await uploadToIPFS({ type: 'job_description', description, createdAt: new Date().toISOString() });
        cidMap.set(hash, cid);

        const body = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(Address.parse(evaluator_address))
            .storeCoins(toNano(budget_ton))
            .storeUint(BigInt('0x' + hash), 256)
            .storeUint(timeout_seconds, 32)
            .storeUint(evaluation_timeout_seconds, 32)
            .endCell();

        const result = await sendTransaction(config.factoryAddress, toNano('0.03'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, ipfs_cid: cid, description_hash: hash }) }] };
    }
);

server.tool(
    'fund_job',
    'Fund a job by sending TON to the job contract address.',
    {
        job_address: z.string().describe('Job contract address'),
        amount_ton: z.string().describe('Amount in TON to send as payment'),
    },
    async ({ job_address, amount_ton }) => {
        const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const total = toNano(amount_ton) + toNano('0.01');
        const result = await sendTransaction(Address.parse(job_address), total, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'take_job',
    'Take a job as a provider. Registers your wallet as the job provider.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'submit_result',
    'Submit a result for a job you have taken. Result is uploaded to IPFS, hash stored on-chain.',
    {
        job_address: z.string().describe('Job contract address'),
        result_text: z.string().describe('Full result text. Will be uploaded to IPFS.'),
    },
    async ({ job_address, result_text }) => {
        // Upload result to IPFS
        const { cid, hash } = await uploadToIPFS({ type: 'job_result', result: result_text, submittedAt: new Date().toISOString() });
        cidMap.set(hash, cid);

        const body = beginCell()
            .storeUint(JobOpcodes.submitResult, 32)
            .storeUint(BigInt('0x' + hash), 256)
            .storeUint(2, 8) // result_type = 2 (IPFS)
            .endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, ipfs_cid: cid, result_hash: hash }) }] };
    }
);

server.tool(
    'evaluate_job',
    'Evaluate a submitted job result. Approve sends funds to provider, reject refunds client.',
    {
        job_address: z.string().describe('Job contract address'),
        approved: z.boolean().describe('true to approve (pay provider), false to reject (refund client)'),
        reason: z.string().optional().describe('Optional reason hash (hex, 64 chars)'),
    },
    async ({ job_address, approved, reason }) => {
        const reasonInt = reason ? BigInt('0x' + reason) : 0n;
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(reasonInt, 256)
            .endCell();
        // 0.06 TON needed for USDT payout gas. For TON jobs excess returns immediately.
        const result = await sendTransaction(Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'cancel_job',
    'Cancel a funded job after timeout expires. Refunds client.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'claim_job',
    'Provider claims funds after evaluation timeout expires. Use when evaluator is silent.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.06'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'quit_job',
    'Provider quits a job before submitting result. Job returns to open for another provider.',
    {
        job_address: z.string().describe('Job contract address'),
    },
    async ({ job_address }) => {
        const body = beginCell().storeUint(JobOpcodes.quit, 32).endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
);

server.tool(
    'set_budget',
    'Set or update the budget for a job in OPEN state. Only client can call.',
    {
        job_address: z.string().describe('Job contract address'),
        budget_ton: z.string().describe('Budget in TON'),
    },
    async ({ job_address, budget_ton }) => {
        const body = beginCell()
            .storeUint(JobOpcodes.setBudget, 32)
            .storeCoins(toNano(budget_ton))
            .endCell();
        const result = await sendTransaction(Address.parse(job_address), toNano('0.01'), body);
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
        const addr = Address.parse(job_address);
        const stateNames = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

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

            // Try to fetch description from IPFS
            let description: string | null = null;
            const descCid = cidMap.get(descHashHex);
            if (descCid) {
                try {
                    const content = await fetchFromIPFS(descCid);
                    description = content.description ?? JSON.stringify(content);
                } catch { /* IPFS fetch failed */ }
            }

            // Try to fetch result from IPFS (if result_type = 2)
            let resultContent: string | null = null;
            if (resultType === 2 && resultHash > 0n) {
                const resCid = cidMap.get(resultHashHex);
                if (resCid) {
                    try {
                        const content = await fetchFromIPFS(resCid);
                        resultContent = content.result ?? JSON.stringify(content);
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
                resultHash: resultHashHex,
                resultContent,
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
        const addr = factory_address
            ? Address.parse(factory_address)
            : config.factoryAddress;
        if (!addr) throw new Error('No factory address provided');

        const nextIdResult = await client.runMethod(addr, 'get_next_job_id');
        const nextId = nextIdResult.stack.readNumber();

        const jobs: any[] = [];
        const end = Math.min(from_id + count, nextId);

        for (let i = from_id; i < end; i++) {
            const addrResult = await client.runMethod(addr, 'get_job_address', [
                { type: 'int', value: BigInt(i) },
            ]);
            const jobAddr = addrResult.stack.readAddress();
            jobs.push({ jobId: i, address: jobAddr.toString() });
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({ totalJobs: nextId, jobs }, null, 2),
            }],
        };
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
    },
    async ({ evaluator_address, budget_usdt, description, timeout_seconds, evaluation_timeout_seconds }) => {
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

        const result = await sendTransaction(config.jettonFactoryAddress, toNano('0.03'), body);

        // In local mode: auto-set USDT wallet after job creation
        let jettonWallet = '';
        if (wallet) {
            try {
                // Wait for job to deploy
                await new Promise(r => setTimeout(r, 8000));
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
                await sendTransaction(jobAddr, toNano('0.01'), setBody);
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
    },
    async ({ job_address }) => {
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
        const result = await sendTransaction(jobAddr, toNano('0.01'), body);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, jetton_wallet: jettonWalletAddr.toString() }) }] };
    }
);

server.tool(
    'fund_jetton_job',
    'Fund a USDT job by sending USDT to the job contract. Resolves client and USDT wallet automatically from on-chain data.',
    {
        job_address: z.string().describe('Jetton job contract address'),
        amount_usdt: z.string().describe('Amount in USDT (e.g. "10" for 10 USDT)'),
    },
    async ({ job_address, amount_usdt }) => {
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

        const result = await sendTransaction(senderJettonWallet, toNano('0.1'), jettonBody);
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

}

// ===== START =====

async function main() {
    await init();
    const port = process.env.PORT;

    if (port) {
        // HTTP mode — for remote deployment (Railway, etc.)
        const app = express();
        app.use(express.json());

        app.post('/mcp', async (req, res) => {
            const server = createServer();
            registerTools(server);
            try {
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
                res.on('close', () => { transport.close(); server.close(); });
            } catch (error) {
                if (!res.headersSent) {
                    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
                }
            }
        });

        app.get('/mcp', (_req, res) => {
            res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        });

        app.delete('/mcp', (_req, res) => {
            res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        });

        app.get('/', (_req, res) => {
            res.json({ name: 'enact-protocol', version: '2.0.0', endpoint: '/mcp' });
        });

        app.listen(Number(port), '0.0.0.0', () => {
            console.log(`ENACT MCP server running on http://0.0.0.0:${port}/mcp`);
        });
    } else {
        // Stdio mode — for local usage (Claude Code, Cursor, etc.)
        const server = createServer();
        registerTools(server);
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

main().catch(console.error);
