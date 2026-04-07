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
import { createServer } from 'http';
import nacl from 'tweetnacl';
import ed2curve from 'ed2curve';
// ─── Config ───
const MNEMONIC = process.env.WALLET_MNEMONIC ?? '';
const LLM_API_KEY = process.env.GROQ_API_KEY ?? '';
const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';
const PINATA_JWT = process.env.PINATA_JWT ?? '';
const DRY_RUN = process.argv.includes('--dry-run');
const INTERVAL = 15_000; // 15 seconds (Catchain 2.0: ~1s finality)

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

async function fetchFromPinata(hash: string, label: string = 'content'): Promise<string | null> {
    // Try hex decode first (legacy: short text stored directly as hex)
    const hex = decodeHex(hash);
    if (hex) {
        log(`  📦 ${label}: decoded from hex`);
        return hex;
    }

    // Try Pinata metadata search
    if (!PINATA_JWT) {
        log(`  ⚠️ ${label}: PINATA_JWT not set, cannot search IPFS`);
        return null;
    }
    try {
        // Bot stores all uploads with keyvalues: { descHash: sha256 }
        const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
        log(`  🔍 ${label}: searching Pinata for hash ${hash.slice(0, 16)}...`);
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${PINATA_JWT}` },
            signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
            const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
            if (pins.rows?.length > 0) {
                const cid = pins.rows[0].ipfs_pin_hash;
                log(`  📌 ${label}: found CID ${cid}`);
                const ipfsRes = await fetch(`${PINATA_GW}/${cid}`, { signal: AbortSignal.timeout(8000) });
                if (ipfsRes.ok) {
                    const data = await ipfsRes.json();
                    return data.description ?? data.result ?? JSON.stringify(data);
                }
            } else {
                log(`  ⚠️ ${label}: no pin found by keyvalues, trying name search...`);
                // Fallback: search by name prefix (enact-{hash8})
                const nameUrl = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=5&metadata[name]=enact-${hash.slice(0, 8)}`;
                const nameRes = await fetch(nameUrl, {
                    headers: { 'Authorization': `Bearer ${PINATA_JWT}` },
                    signal: AbortSignal.timeout(8000),
                });
                if (nameRes.ok) {
                    const namePins = await nameRes.json() as { rows: Array<{ ipfs_pin_hash: string }> };
                    if (namePins.rows?.length > 0) {
                        const cid = namePins.rows[0].ipfs_pin_hash;
                        log(`  📌 ${label}: found by name, CID ${cid}`);
                        const ipfsRes = await fetch(`${PINATA_GW}/${cid}`, { signal: AbortSignal.timeout(8000) });
                        if (ipfsRes.ok) {
                            const data = await ipfsRes.json();
                            return data.description ?? data.result ?? JSON.stringify(data);
                        }
                    } else {
                        log(`  ❌ ${label}: no pin found at all`);
                    }
                }
            }
        } else {
            log(`  ❌ ${label}: Pinata API error ${res.status}`);
        }
    } catch (err: any) {
        log(`  ❌ ${label}: fetch error: ${err.message}`);
    }
    return null;
}

/** Decrypt an encrypted result envelope using evaluator's secret key */
function decryptEnvelope(envelope: any, secretKey: Buffer): string | null {
    if (envelope?.type !== 'job_result_encrypted') return null;
    try {
        const recipient = envelope.recipients?.find((r: any) => r.role === 'evaluator');
        if (!recipient) return null;
        const recipientX25519Sec = ed2curve.convertSecretKey(new Uint8Array(secretKey));
        const senderX25519Pub = ed2curve.convertPublicKey(new Uint8Array(Buffer.from(envelope.senderPublicKey, 'hex')));
        if (!senderX25519Pub) return null;
        const encKey = new Uint8Array(Buffer.from(recipient.encryptedKey, 'base64'));
        const boxNonce = new Uint8Array(Buffer.from(recipient.nonce, 'base64'));
        const symKey = nacl.box.open(encKey, boxNonce, senderX25519Pub, recipientX25519Sec);
        if (!symKey) return null;
        const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, 'base64'));
        const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'base64'));
        const plaintext = nacl.secretbox.open(ciphertext, nonce, symKey);
        if (!plaintext) return null;
        return new TextDecoder().decode(plaintext);
    } catch {
        return null;
    }
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
    if (!LLM_API_KEY) { console.error('GROQ_API_KEY not set'); process.exit(1); }
    const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: API_KEY });
    const keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const walletContract = client.open(wallet);
    const myAddr = wallet.address.toString({ bounceable: false });

    const LLM_URL = process.env.LLM_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

    async function askLLM(prompt: string): Promise<string> {
        const res = await fetch(LLM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
            body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
        });
        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
        const data = await res.json() as any;
        return data.choices[0].message.content.trim();
    }

    const evaluated = new Set<string>();

    // ─── Health HTTP server (keeps Render Web Service alive) ───
    const PORT = parseInt(process.env.PORT || '10000', 10);
    let lastScan = Date.now();
    let scanCount = 0;
    createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'enact-ai-evaluator',
            uptime: Math.floor(process.uptime()),
            lastScan: new Date(lastScan).toISOString(),
            scanCount,
            dryRun: DRY_RUN,
        }));
    }).listen(PORT, () => log(`🌐 Health server on :${PORT}`));

    // ─── IdentityHub heartbeat (every 3 min) ───
    const IH_KEY = process.env.IDENTITY_HUB_KEY || '';
    if (IH_KEY) {
        const sendHeartbeat = () => {
            fetch('https://api.identityhub.app/agents/me/heartbeat', {
                method: 'POST',
                headers: { 'X-Agent-Key': IH_KEY },
            }).then(() => log('💓 IdentityHub heartbeat sent')).catch(() => {});
        };
        sendHeartbeat();
        setInterval(sendHeartbeat, 180_000);
    }

    log(`🤖 ENACT AI Evaluator started${DRY_RUN ? ' (DRY RUN)' : ''}`);
    log(`🧠 LLM: ${LLM_MODEL} via ${LLM_URL.includes('groq') ? 'Groq' : 'OpenAI-compatible'}`);
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
                } catch (err: any) {
                    log(`⚠️ ${factory.label} factory error: ${err.message}`);
                    continue;
                }
                log(`  📊 ${factory.label}: ${jobCount} jobs`);

                for (let i = 0; i < jobCount; i++) {
                    const jobKey = `${factory.label}#${i}`;
                    if (evaluated.has(jobKey)) continue;

                    try {
                        await sleep(400); // rate limit
                        const addrRes = await client.runMethod(Address.parse(factory.addr), 'get_job_address', [
                            { type: 'int', value: BigInt(i) },
                        ]);
                        const jobAddr = addrRes.stack.readAddress();
                        const jobAddrStr = jobAddr.toString();

                        await sleep(400);
                        const status = await getJobStatus(client, jobAddrStr);

                        if (status.stateName !== 'SUBMITTED') continue;

                        // Compare addresses in raw form to avoid bounceable/non-bounceable mismatch
                        const jobEvaluator = Address.parse(status.evaluator).toRawString();
                        const myAddrRaw = wallet.address.toRawString();
                        if (jobEvaluator !== myAddrRaw) {
                            log(`  ⏭️ ${jobKey}: evaluator mismatch (job=${status.evaluator.slice(0,12)}... me=${myAddr.slice(0,12)}...)`);
                            continue;
                        }

                        log(`\n📋 ${jobKey} (${jobAddrStr.slice(0, 12)}...): SUBMITTED — evaluating...`);

                        // Load description and result from IPFS
                        const description = await fetchFromPinata(status.descHash, 'description') ?? '(no description)';
                        let result = await fetchFromPinata(status.resultHash, 'result') ?? '(no result)';

                        // Detect and decrypt encrypted results
                        let wasEncrypted = false;
                        try {
                            const parsed = JSON.parse(result);
                            if (parsed?.type === 'job_result_encrypted') {
                                log(`🔐 Result is E2E encrypted — decrypting as evaluator...`);
                                const decrypted = decryptEnvelope(parsed, keyPair.secretKey);
                                if (decrypted) {
                                    result = decrypted;
                                    wasEncrypted = true;
                                    log(`🔓 Decrypted successfully (${result.length} chars)`);
                                } else {
                                    log(`⚠️ Decryption failed — evaluating encrypted envelope as-is`);
                                }
                            }
                        } catch { /* not JSON or not encrypted — use as-is */ }

                        log(`📄 Description: "${description.slice(0, 80)}"`);
                        log(`📝 Result${wasEncrypted ? ' (decrypted)' : ''}: "${result.slice(0, 80)}"`);

                        // Ask Gemini
                        const prompt = `You are a job evaluator for an on-chain escrow protocol on TON blockchain.

APPROVE if:
- Result addresses the task described in the job description
- Available data is presented accurately with source citations
- Agent honestly states when specific data is unavailable from APIs
- Analysis is based on real API data, not invented numbers

REJECT only if:
- Result does not address the task at all
- Result contains obviously fabricated data (fake addresses, invented TVL numbers)
- Result is empty or just a few generic sentences with no substance
- Critical data that IS available was ignored (e.g. STONfi API returns APY but agent wrote "not available")

Do NOT reject for:
- Missing data from APIs that genuinely don't provide it (DeDust detailed APY, Tonco pool data, Hipo TVL on DefiLlama)
- Partial results when some APIs timed out — if agent noted the timeout, that is honest work
- Not covering every single protocol — if the main question was answered with available data
- Writing "Data not available from API" — this is correct behavior, not a failure

CRITICAL FACTS about TON DeFi:
- DEXes: STONfi, DeDust, Tonco. ONLY these three.
- tonstakers, Bemo, Hipo = LIQUID STAKING, NOT DEXes. Never penalize for correctly categorizing them.
- There is no "wTON" token on TON.

Respond ONLY with JSON, no markdown, no code blocks: {"approved": true or false, "reason": "brief reason"}

Job description: ${description}
Submitted result: ${result}`;

                        let approved = false;
                        let reason = '';

                        try {
                            log(`🧠 Calling LLM for ${jobKey}...`);
                            const text = await askLLM(prompt);
                            log(`🧠 LLM response: ${text}`);

                            // Parse JSON — handle possible markdown wrapping
                            const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                            const parsed = JSON.parse(jsonStr);
                            approved = !!parsed.approved;
                            reason = String(parsed.reason || '');
                        } catch (err: any) {
                            log(`⚠️ Gemini parse error: ${err.message} — skipping`);
                            continue;
                        }

                        log(`${approved ? '✅' : '❌'} Decision: ${approved ? 'APPROVED' : 'REJECTED'} — "${reason.slice(0, 80)}"`);

                        if (DRY_RUN) {
                            log(`🔒 DRY RUN — not sending transaction`);
                            evaluated.add(jobKey);
                            continue;
                        }

                        // Send evaluate transaction
                        try {
                            let reasonHash: bigint;
                            const reasonBytes = Buffer.from(reason);
                            if (reasonBytes.length <= 32) {
                                // Short reason — store directly on-chain
                                reasonHash = BigInt('0x' + reasonBytes.toString('hex').padEnd(64, '0').slice(0, 64));
                            } else if (PINATA_JWT) {
                                // Long reason — upload to IPFS, store hash
                                const { createHash } = await import('crypto');
                                const json = JSON.stringify({ type: 'evaluation_reason', reason, evaluatedAt: new Date().toISOString() });
                                const hash = createHash('sha256').update(json, 'utf-8').digest('hex');
                                const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PINATA_JWT}` },
                                    body: JSON.stringify({
                                        pinataContent: { type: 'evaluation_reason', reason, evaluatedAt: new Date().toISOString() },
                                        pinataMetadata: { name: `enact-reason-${hash.slice(0, 8)}`, keyvalues: { descHash: hash } },
                                    }),
                                });
                                if (res.ok) {
                                    log(`📌 Reason uploaded to IPFS (${reason.length} chars)`);
                                    reasonHash = BigInt('0x' + hash);
                                } else {
                                    // Fallback: truncate
                                    reasonHash = BigInt('0x' + reasonBytes.toString('hex').padEnd(64, '0').slice(0, 64));
                                }
                            } else {
                                // No IPFS — truncate
                                reasonHash = BigInt('0x' + reasonBytes.toString('hex').padEnd(64, '0').slice(0, 64));
                            }
                            const body = beginCell()
                                .storeUint(0x00000004, 32) // evaluate opcode
                                .storeUint(approved ? 1 : 0, 8)
                                .storeUint(reasonHash, 256)
                                .endCell();

                            await sleep(1000);
                            const seqno = await walletContract.getSeqno();
                            await walletContract.sendTransfer({
                                seqno,
                                secretKey: keyPair.secretKey,
                                sendMode: SendMode.PAY_GAS_SEPARATELY,
                                messages: [internal({
                                    to: jobAddr,
                                    value: toNano(factory.label === 'USDT' ? '0.06' : '0.01'),
                                    body,
                                    bounce: true,
                                })],
                            });

                            log(`📦 Tx sent (seqno=${seqno}). Waiting confirmation...`);
                            await sleep(2000);

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
                        log(`  ❌ ${jobKey} error: ${err.message}`);
                        continue;
                    }
                }
            }
        } catch (err: any) {
            log(`❌ Scan error: ${err.message}`);
        }

        lastScan = Date.now();
        scanCount++;
        await sleep(INTERVAL);
        log(`🔍 Scanning...`);
    }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
