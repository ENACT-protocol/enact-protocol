/**
 * ENACT x402 Vendor — HTTP 402 endpoint for ENACT Protocol jobs.
 *
 * Flow:
 * 1. Agent GET /jobs/:id/pay → receives 402 with PaymentRequirements
 * 2. Agent creates signed payment payload via x402ton SDK
 * 3. Agent POST /jobs/:id/pay with X-PAYMENT header
 * 4. Vendor verifies via facilitator, calls fund_job on-chain
 * 5. Job transitions to FUNDED
 */

import { Hono } from 'hono';
import { Address, beginCell, toNano, TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

interface VendorConfig {
    factoryAddress: string;
    walletMnemonic: string[];
    tonEndpoint: string;
    tonApiKey?: string;
    facilitatorUrl?: string;
}

export function createEnactVendor(config: VendorConfig) {
    const app = new Hono();
    const facilitatorUrl = config.facilitatorUrl ?? 'https://x402.resistance.dog';

    let client: TonClient;
    let wallet: WalletContractV5R1;
    let keyPair: { publicKey: Buffer; secretKey: Buffer };

    async function init() {
        client = new TonClient({ endpoint: config.tonEndpoint, apiKey: config.tonApiKey });
        keyPair = await mnemonicToPrivateKey(config.walletMnemonic);
        wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    }

    // GET /jobs/:id/pay — Return 402 Payment Required
    app.get('/jobs/:id/pay', async (c) => {
        const jobId = parseInt(c.req.param('id'));

        try {
            await init();
            const factoryAddr = Address.parse(config.factoryAddress);
            const jobAddrResult = await client.runMethod(factoryAddr, 'get_job_address', [
                { type: 'int', value: BigInt(jobId) },
            ]);
            const jobAddr = jobAddrResult.stack.readAddress();

            const jobDataResult = await client.runMethod(jobAddr, 'get_job_data');
            const _jobId = jobDataResult.stack.readNumber();
            const _client = jobDataResult.stack.readAddress();
            const _provider = jobDataResult.stack.readAddressOpt();
            const _evaluator = jobDataResult.stack.readAddress();
            const budget = jobDataResult.stack.readBigNumber();

            const paymentRequirements = {
                scheme: 'ton',
                network: 'mainnet',
                payTo: jobAddr.toString(),
                maxAmountRequired: budget.toString(),
                resource: `/jobs/${jobId}/pay`,
                description: `Fund ENACT Job #${jobId}`,
                mimeType: 'application/json',
                extra: {
                    jobId,
                    jobAddress: jobAddr.toString(),
                    opcode: '0x00000001', // FundJob
                },
            };

            return c.json(paymentRequirements, 402);
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    // POST /jobs/:id/pay — Verify payment and fund job
    app.post('/jobs/:id/pay', async (c) => {
        const jobId = parseInt(c.req.param('id'));
        const paymentHeader = c.req.header('X-PAYMENT');

        if (!paymentHeader) {
            return c.json({ error: 'Missing X-PAYMENT header' }, 400);
        }

        try {
            await init();

            // Verify payment via facilitator
            const verifyResponse = await fetch(`${facilitatorUrl}/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    payment: paymentHeader,
                    paymentRequirements: {
                        scheme: 'ton',
                        network: 'mainnet',
                    },
                }),
            });

            if (!verifyResponse.ok) {
                return c.json({ error: 'Payment verification failed' }, 402);
            }

            // Fund the job on-chain
            const factoryAddr = Address.parse(config.factoryAddress);
            const jobAddrResult = await client.runMethod(factoryAddr, 'get_job_address', [
                { type: 'int', value: BigInt(jobId) },
            ]);
            const jobAddr = jobAddrResult.stack.readAddress();

            const jobDataResult = await client.runMethod(jobAddr, 'get_job_data');
            const _jobId = jobDataResult.stack.readNumber();
            const _client = jobDataResult.stack.readAddress();
            const _provider = jobDataResult.stack.readAddressOpt();
            const _evaluator = jobDataResult.stack.readAddress();
            const budget = jobDataResult.stack.readBigNumber();

            const body = beginCell().storeUint(0x00000001, 32).endCell(); // FundJob
            const contract = client.open(wallet);
            const seqno = await contract.getSeqno();

            await contract.sendTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages: [internal({
                    to: jobAddr,
                    value: budget + toNano('0.1'),
                    body,
                    bounce: true,
                })],
            });

            // Settle via facilitator
            await fetch(`${facilitatorUrl}/settle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payment: paymentHeader }),
            });

            return c.json({
                status: 'funded',
                jobId,
                jobAddress: jobAddr.toString(),
                amount: budget.toString(),
            });
        } catch (e: any) {
            return c.json({ error: e.message }, 500);
        }
    });

    // Health check
    app.get('/health', (c) => c.json({ status: 'ok', protocol: 'enact', version: '2.0' }));

    return app;
}
