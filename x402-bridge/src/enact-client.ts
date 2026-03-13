/**
 * ENACT x402 Client — Pay for ENACT jobs via HTTP 402 protocol.
 *
 * Flow:
 * 1. GET vendor endpoint → receive PaymentRequirements (402)
 * 2. Sign payment off-chain using TON wallet
 * 3. POST with X-PAYMENT header → vendor funds job on-chain
 *
 * This enables AI agents to pay for jobs without direct blockchain interaction.
 */

import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

interface PayForJobOptions {
    vendorUrl: string;
    jobId: number;
    mnemonic: string[];
}

interface PaymentResult {
    status: string;
    jobId: number;
    jobAddress: string;
    amount: string;
}

/**
 * Pay for a ENACT job via x402 protocol.
 *
 * @example
 * ```typescript
 * const result = await payForJob({
 *     vendorUrl: 'http://localhost:3402',
 *     jobId: 0,
 *     mnemonic: 'word1 word2 ...'.split(' '),
 * });
 * console.log(`Job ${result.jobId} funded: ${result.amount} nanotons`);
 * ```
 */
export async function payForJob(options: PayForJobOptions): Promise<PaymentResult> {
    const { vendorUrl, jobId, mnemonic } = options;

    // Step 1: Get payment requirements
    const requirementsResponse = await fetch(`${vendorUrl}/jobs/${jobId}/pay`);

    if (requirementsResponse.status !== 402) {
        throw new Error(`Expected 402, got ${requirementsResponse.status}`);
    }

    const requirements = await requirementsResponse.json();

    // Step 2: Create signed payment
    // In production, this would use x402ton SchemeNetworkClient
    // For now, we create a simplified payment proof
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });

    const paymentPayload = {
        scheme: 'ton',
        network: requirements.network ?? 'mainnet',
        payer: wallet.address.toString(),
        payTo: requirements.payTo,
        amount: requirements.maxAmountRequired,
        timestamp: Math.floor(Date.now() / 1000),
        resource: requirements.resource,
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    // Step 3: Submit payment
    const payResponse = await fetch(`${vendorUrl}/jobs/${jobId}/pay`, {
        method: 'POST',
        headers: {
            'X-PAYMENT': paymentHeader,
            'Content-Type': 'application/json',
        },
    });

    if (!payResponse.ok) {
        const error = await payResponse.json();
        throw new Error(`Payment failed: ${error.error ?? payResponse.statusText}`);
    }

    return payResponse.json();
}
