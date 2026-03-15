/**
 * ENACT AI Evaluator Agent
 *
 * Autonomous agent that monitors submitted jobs, reviews results
 * using Google Gemini, and auto-approves or rejects.
 *
 * Usage:
 *   npx ts-node scripts/evaluator-agent.ts
 *   npx ts-node scripts/evaluator-agent.ts --dry-run
 *
 * Env:
 *   WALLET_MNEMONIC  — evaluator wallet (24 words)
 *   GEMINI_API_KEY   — Google Gemini API key
 *   TONCENTER_API_KEY — TON RPC key
 *   PINATA_GATEWAY   — IPFS gateway (optional)
 */

import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano } from '@ton/core';
// ─── Config ───
const MNEMONIC = process.env.WALLET_MNEMONIC ?? '';
const LLM_API_KEY = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY ?? '';
const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';
const PINATA_JWT = process.env.PINATA_JWT ?? '';
const DRY_RUN = process.argv.includes('--dry-run');
const INTERVAL = 60_000; // 60 seconds

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

const STATES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

// ─── Helpers ───
function log(msg: string) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[${time}] ${msg}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeHex(hash: string): string | null {
    if (!hash || hash === '0'.repeat(64)) return null;
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length < 2) return null;
        const text = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
        if (/^[\x20-\x7E]+$/.test(text) && text.length > 2) return text;
    } catch {}
    return null;
}

async function fetchFromPinata(hash: string): Promise<string | null> {
    // Try hex decode first
    const hex = decodeHex(hash);
    if (hex) return hex;

    // Try Pinata metadata search
    if (!PINATA_JWT) return null;
    try {
        const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${PINATA_JWT}` },
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
            if (pins.rows?.length > 0) {
                const ipfsRes = await fetch(`${PINATA_GW}/${pins.rows[0].ipfs_pin_hash}`, { signal: AbortSignal.timeout(5000) });
                if (ipfsRes.ok) {
                    const data = await ipfsRes.json();
                    return data.description ?? data.result ?? JSON.stringify(data);
                }
            }
        }
    } catch {}
    return null;
}

async function getJobStatus(client: TonClient, jobAddress: string) {
    const addr = Address.parse(jobAddress);
    const result = await client.runMethod(addr, 'get_job_data');

    const jobId = result.stack.readNumber();
    const clientAddr = result.stack.readAddress();
    const providerAddr = result.stack.readAddressOpt();
    const evaluatorAddr = result.stack.readAddress();
    const budget = result.stack.readBigNumber();
    const descHash = result.stack.readBigNumber();
    const resultHash = result.stack.readBigNumber();
    const timeout = result.stack.readNumber();
    result.stack.readNumber(); // createdAt
    result.stack.readNumber(); // evalTimeout
    result.stack.readNumber(); // submittedAt
    result.stack.readNumber(); // resultType
    result.stack.readBigNumber(); // reason
    const state = result.stack.readNumber();

    return {
        jobId, state, stateName: STATES[state],
        client: clientAddr.toString({ bounceable: false }),
        provider: providerAddr?.toString({ bounceable: false }) ?? 'none',
        evaluator: evaluatorAddr.toString({ bounceable: false }),
        budget,
        descHash: descHash.toString(16).padStart(64, '0'),
        resultHash: resultHash.toString(16).padStart(64, '0'),
    };
}

// ─── Main ───
async function main() {
    if (!MNEMONIC) { console.error('WALLET_MNEMONIC not set'); process.exit(1); }
    if (!LLM_API_KEY) { console.error('GROQ_API_KEY or GEMINI_API_KEY not set'); process.exit(1); }

    const useGroq = !!process.env.GROQ_API_KEY;
    const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: API_KEY });
    const keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const walletContract = client.open(wallet);
    const myAddr = wallet.address.toString({ bounceable: false });

    async function askLLM(prompt: string): Promise<string> {
        if (useGroq) {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
                body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
            });
            if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
            const data = await res.json() as any;
            return data.choices[0].message.content.trim();
        } else {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(LLM_API_KEY);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        }
    }

    const evaluated = new Set<string>();

    log(`🤖 ENACT AI Evaluator started${DRY_RUN ? ' (DRY RUN)' : ''}`);
    log(`🧠 LLM: ${useGroq ? 'Groq (llama-3.3-70b)' : 'Gemini (2.0-flash)'}`);
    log(`👛 Evaluator address: ${myAddr}`);
    log(`🔍 Scanning every ${INTERVAL / 1000}s...`);

    while (true) {
        try {
            const factories = [
                { addr: FACTORY, label: 'TON' },
                { addr: JETTON_FACTORY, label: 'USDT' },
            ];

            for (const factory of factories) {
                let jobCount = 0;
                try {
                    const r = await client.runMethod(Address.parse(factory.addr), 'get_next_job_id');
                    jobCount = r.stack.readNumber();
                } catch { continue; }

                for (let i = 0; i < jobCount; i++) {
                    const jobKey = `${factory.label}#${i}`;
                    if (evaluated.has(jobKey)) continue;

                    try {
                        await sleep(1500); // rate limit
                        const addrRes = await client.runMethod(Address.parse(factory.addr), 'get_job_address', [
                            { type: 'int', value: BigInt(i) },
                        ]);
                        const jobAddr = addrRes.stack.readAddress();
                        const jobAddrStr = jobAddr.toString();

                        await sleep(1500);
                        const status = await getJobStatus(client, jobAddrStr);

                        if (status.stateName !== 'SUBMITTED') continue;
                        if (status.evaluator !== myAddr) continue;

                        log(`\n📋 ${jobKey} (${jobAddrStr.slice(0, 12)}...): SUBMITTED — evaluating...`);

                        // Load description and result
                        const description = await fetchFromPinata(status.descHash) ?? '(no description)';
                        const result = await fetchFromPinata(status.resultHash) ?? '(no result)';

                        log(`📄 Description: "${description.slice(0, 80)}"`);
                        log(`📝 Result: "${result.slice(0, 80)}"`);

                        // Ask Gemini
                        const prompt = `You are a job evaluator for an escrow protocol. You receive a job description and a submitted result. Evaluate if the result satisfies the job requirements. Respond ONLY with JSON, no markdown, no code blocks: {"approved": true or false, "reason": "brief reason"}

Job description: ${description}
Submitted result: ${result}`;

                        let approved = false;
                        let reason = '';

                        try {
                            log(`🧠 Calling ${useGroq ? 'Groq' : 'Gemini'} for ${jobKey}...`);
                            const text = await askLLM(prompt);
                            log(`🧠 LLM response: ${text}`);

                            // Parse JSON — handle possible markdown wrapping
                            const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                            const parsed = JSON.parse(jsonStr);
                            approved = !!parsed.approved;
                            reason = String(parsed.reason || '').slice(0, 60);
                        } catch (err: any) {
                            log(`⚠️ Gemini parse error: ${err.message} — skipping`);
                            continue;
                        }

                        log(`${approved ? '✅' : '❌'} Decision: ${approved ? 'APPROVED' : 'REJECTED'} — "${reason}"`);

                        if (DRY_RUN) {
                            log(`🔒 DRY RUN — not sending transaction`);
                            evaluated.add(jobKey);
                            continue;
                        }

                        // Send evaluate transaction
                        try {
                            const reasonHash = BigInt('0x' + Buffer.from(reason).toString('hex').padEnd(64, '0').slice(0, 64));
                            const body = beginCell()
                                .storeUint(0x00000004, 32) // evaluate opcode
                                .storeUint(approved ? 1 : 0, 8)
                                .storeUint(reasonHash, 256)
                                .endCell();

                            await sleep(3000);
                            const seqno = await walletContract.getSeqno();
                            await walletContract.sendTransfer({
                                seqno,
                                secretKey: keyPair.secretKey,
                                sendMode: SendMode.PAY_GAS_SEPARATELY,
                                messages: [internal({
                                    to: jobAddr,
                                    value: toNano('0.06'), // extra for USDT payout
                                    body,
                                    bounce: true,
                                })],
                            });

                            log(`📦 Tx sent (seqno=${seqno}). Waiting confirmation...`);
                            await sleep(15000);

                            const newStatus = await getJobStatus(client, jobAddrStr);
                            if (newStatus.stateName === 'COMPLETED' || newStatus.stateName === 'DISPUTED') {
                                log(`✅ ${jobKey} → ${newStatus.stateName}`);
                            } else {
                                log(`⚠️ ${jobKey} still ${newStatus.stateName} — tx may have failed`);
                            }
                        } catch (err: any) {
                            log(`❌ Tx error: ${err.message}`);
                        }

                        evaluated.add(jobKey);
                    } catch (err: any) {
                        // Skip individual job errors
                        continue;
                    }
                }
            }
        } catch (err: any) {
            log(`❌ Scan error: ${err.message}`);
        }

        await sleep(INTERVAL);
        log(`🔍 Scanning...`);
    }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
