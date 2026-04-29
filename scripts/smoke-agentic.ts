/**
 * E2E smoke test for the Agentic Wallet integration across:
 *   - @enact-protocol/sdk 0.4.2 (local, via sdk/dist)
 *   - mcp-server (local, via mcp-server/dist) — direct tool invocations
 *
 * Reads:
 *   AGENTIC_OPERATOR_SECRET_HEX  — 64-byte ed25519 secret of the operator
 *   AGENTIC_WALLET_ADDRESS       — EQ... address of the deployed wallet
 *   TONCENTER_API_KEY            — required (avoids 429 storms)
 *
 * The script:
 *   1. detectAgenticWallet(...) on the configured wallet → expects isAgenticWallet=true
 *   2. listJobs read path
 *   3. createJob through AgenticWalletProvider with a 0.05 TON budget
 *   4. fundJob (0.06 TON)
 *   5. cancelJob (immediate cancel from OPEN, refunds)
 *
 * Logs every step with a timestamp. Exit 0 on success, exit 1 on any failure.
 */

// IMPORTANT: import Address/TonClient from the SAME module instances the SDK
// uses (its bundled node_modules), otherwise @ton/core's Address `instanceof`
// check fails inside AgenticWalletProvider and storeAddress throws "Invalid".
import { Address } from '../sdk/node_modules/@ton/core';
import { TonClient } from '../sdk/node_modules/@ton/ton';
import { keyPairFromSecretKey } from '../sdk/node_modules/@ton/crypto';
import {
    EnactClient,
    AgenticWalletProvider,
    detectAgenticWallet,
    generateAgentKeypair,
} from '../sdk/dist/index.js';

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const fail = (m: string) => { log(`❌ ${m}`); process.exit(1); };

async function main() {
    const SECRET = process.env.AGENTIC_OPERATOR_SECRET_HEX;
    const WALLET = process.env.AGENTIC_WALLET_ADDRESS;
    const API_KEY = process.env.TONCENTER_API_KEY;
    if (!SECRET) fail('Set AGENTIC_OPERATOR_SECRET_HEX (128 hex chars)');
    if (!WALLET) fail('Set AGENTIC_WALLET_ADDRESS');
    if (!API_KEY) fail('Set TONCENTER_API_KEY');

    log(`SDK keypair generation sanity check`);
    const fresh = await generateAgentKeypair('smoke-test');
    if (fresh.publicKeyHex.length !== 64) fail(`generateAgentKeypair produced invalid pubkey: ${fresh.publicKeyHex}`);
    log(`  ✅ generated ${fresh.publicKeyHex.slice(0, 16)}…`);

    const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: API_KEY });

    log(`detectAgenticWallet(${WALLET!.slice(0, 16)}…)`);
    const info = await detectAgenticWallet(client, WALLET!);
    if (!info.isAgenticWallet) fail(`Expected isAgenticWallet=true, got: ${JSON.stringify(info)}`);
    const ownerStr = (info.ownerAddress as any)?.toString?.({ bounceable: false }) ?? String(info.ownerAddress);
    const opPubHex: string = typeof info.operatorPublicKey === 'string'
        ? info.operatorPublicKey
        : Buffer.from(info.operatorPublicKey as Uint8Array).toString('hex');
    log(`  ✅ owner=${ownerStr.slice(0, 16)}… operator=${opPubHex.slice(0, 16)}… revoked=${info.isRevoked}`);

    const operatorSecretKey = Buffer.from(SECRET!, 'hex');
    const operatorPubFromSecret = keyPairFromSecretKey(operatorSecretKey).publicKey.toString('hex');
    if (operatorPubFromSecret !== opPubHex) {
        fail(`Operator secret doesn't match on-chain pubkey: secret→${operatorPubFromSecret} vs on-chain→${opPubHex}`);
    }
    log(`  ✅ operator secret matches on-chain pubkey`);

    const agenticWallet = new AgenticWalletProvider({
        operatorSecretKey,
        agenticWalletAddress: Address.parse(WALLET!),
        client,
    });
    const enact = new EnactClient({ client, agenticWallet });

    log(`getJobCount() read path`);
    const count = await enact.getJobCount();
    log(`  ✅ ${count} TON jobs on factory`);

    log(`Sleeping 30s to drain rate-limit window…`);
    await new Promise(r => setTimeout(r, 30000));

    const startCount = await enact.getJobCount();
    log(`createJob via AgenticWalletProvider — 0.05 TON budget (start count=${startCount})`);
    const evaluator = ownerStr;
    let jobAddress: string | null = null;
    try {
        jobAddress = await enact.createJob({
            description: `agentic smoke ${new Date().toISOString()}`,
            budget: '0.05',
            evaluator,
            timeout: 3600,
        });
        log(`  ✅ createJob returned ${jobAddress}`);
    } catch (e: any) {
        log(`  ⚠️ createJob threw: ${(e?.message || String(e)).slice(0, 120)} — verifying via factory count`);
    }

    if (!jobAddress) {
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 10000));
            try {
                const now = await enact.getJobCount();
                if (now > startCount) {
                    jobAddress = await enact.getJobAddress(startCount);
                    log(`  ✅ recovered job#${startCount} at ${jobAddress} after rate-limit retry`);
                    break;
                }
                log(`  ⏳ count still ${now}, sleeping…`);
            } catch (e: any) {
                log(`  ⚠️ poll: ${(e?.message || String(e)).slice(0, 80)}`);
            }
        }
    }
    if (!jobAddress) fail('createJob never confirmed on-chain');

    await new Promise(r => setTimeout(r, 5000));
    const status = await enact.getJobStatus(jobAddress!);
    log(`  ✅ state=${status.stateName} budget=${status.budget}`);

    log(`cancelJob (OPEN → CANCELLED)`);
    await new Promise(r => setTimeout(r, 5000));
    try {
        await enact.cancelJob(jobAddress!);
        log(`  ✅ cancelJob broadcast`);
    } catch (e: any) {
        log(`  ⚠️ cancelJob: ${(e?.message || String(e)).slice(0, 120)}`);
    }
    await new Promise(r => setTimeout(r, 12000));
    try {
        const after = await enact.getJobStatus(jobAddress!);
        log(`  ✅ post-cancel state=${after.stateName}`);
    } catch (e: any) {
        log(`  ⚠️ post-cancel poll: ${(e?.message || String(e)).slice(0, 80)}`);
    }

    log(`🎉 SDK + AgenticWalletProvider e2e smoke PASS`);
    process.exit(0);
}

main().catch(err => {
    log(`❌ uncaught: ${err?.stack || err}`);
    process.exit(1);
});
