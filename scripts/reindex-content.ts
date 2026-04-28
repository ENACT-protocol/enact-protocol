/**
 * One-time script to restore description/result text in Supabase
 * from on-chain hashes via IPFS public gateways.
 *
 * Usage: npx ts-node scripts/reindex-content.ts
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, PINATA_JWT (optional)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const PINATA_JWT = process.env.PINATA_JWT || '';
const IPFS_GW = 'https://ipfs.io/ipfs';
const ZERO_HASH = '0'.repeat(64);

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchIPFS(cid: string): Promise<any> {
    const sub = process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN;
    const urls: string[] = [];
    if (sub) urls.push(`https://${sub}.lighthouseweb3.xyz/ipfs/${cid}`);
    urls.push(
        `https://w3s.link/ipfs/${cid}`,
        `https://nftstorage.link/ipfs/${cid}`,
        `https://dweb.link/ipfs/${cid}`,
        `${IPFS_GW}/${cid}`,
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const fetches = urls.map(async (u) => {
            const r = await fetch(u, { signal: ctrl.signal });
            if (!r.ok) throw new Error(`${u}: ${r.status}`);
            return await r.json();
        });
        return await Promise.any(fetches);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        ctrl.abort();
    }
}

async function lighthouseSearch(hash: string): Promise<{ cid: string; fileName: string } | null> {
    const key = process.env.LIGHTHOUSE_API_KEY;
    if (!key) return null;
    try {
        const res = await fetch('https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null', {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const data = await res.json() as { fileList?: Array<{ cid: string; fileName: string }> };
        const tag = hash.slice(0, 8);
        const match = data.fileList?.find(f => f.fileName?.startsWith(`enact-${tag}`) || f.fileName?.startsWith(`enact-file-${tag}`));
        return match ? { cid: match.cid, fileName: match.fileName } : null;
    } catch { return null; }
}

async function resolveHash(hash: string): Promise<{ text: string | null; fileCid: string | null; fileName: string | null; ipfsUrl: string | null }> {
    if (!hash || hash === ZERO_HASH) return { text: null, fileCid: null, fileName: null, ipfsUrl: null };

    // 1. Hex decode
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 4) {
            const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) {
                return { text: bytes, fileCid: null, fileName: null, ipfsUrl: null };
            }
        }
    } catch {}

    // 2. Lighthouse search (primary provider in the SDK)
    const lh = await lighthouseSearch(hash);
    if (lh) {
        if (lh.fileName.endsWith('.json')) {
            const data = await fetchIPFS(lh.cid);
            if (data) {
                const text = data.description ?? data.result ?? data.reason ?? null;
                return { text, fileCid: data.file?.cid || null, fileName: data.file?.filename || null, ipfsUrl: `${IPFS_GW}/${lh.cid}` };
            }
        } else {
            return { text: null, fileCid: lh.cid, fileName: lh.fileName, ipfsUrl: `${IPFS_GW}/${lh.cid}` };
        }
    }

    // 3. Pinata search
    if (PINATA_JWT) {
        try {
            const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=5&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${PINATA_JWT}` }, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { keyvalues?: Record<string, string> } }> };
                let fileFallback: { cid: string; filename: string } | null = null;
                for (const pin of (pins.rows ?? [])) {
                    const kv = pin.metadata?.keyvalues;
                    const cid = pin.ipfs_pin_hash;
                    if (kv?.type === 'file') {
                        fileFallback = { cid, filename: kv.filename || 'file' };
                        continue;
                    }
                    const data = await fetchIPFS(cid);
                    if (data) {
                        const text = data.description ?? data.result ?? data.reason ?? null;
                        return { text, fileCid: data.file?.cid || null, fileName: data.file?.filename || null, ipfsUrl: `${IPFS_GW}/${cid}` };
                    }
                }
                if (fileFallback) {
                    return { text: null, fileCid: fileFallback.cid, fileName: fileFallback.filename, ipfsUrl: `${IPFS_GW}/${fileFallback.cid}` };
                }
            }
        } catch {}
    }

    return { text: null, fileCid: null, fileName: null, ipfsUrl: null };
}

async function main() {
    console.log('Fetching jobs with missing content...');

    const { data: jobs, error } = await sb.from('jobs').select('id, address, desc_hash, result_hash, description_text, result_text, description_file_cid, result_file_cid');
    if (error || !jobs) { console.error('Failed:', error?.message); return; }

    const needsFix = jobs.filter(j =>
        (j.desc_hash && j.desc_hash !== ZERO_HASH && !j.description_text) ||
        (j.result_hash && j.result_hash !== ZERO_HASH && !j.result_text)
    );

    console.log(`${needsFix.length} jobs need content restoration out of ${jobs.length} total`);

    for (const job of needsFix) {
        console.log(`\nProcessing ${job.address}...`);
        const updates: Record<string, any> = {};

        // Description
        if (job.desc_hash && job.desc_hash !== ZERO_HASH && !job.description_text) {
            console.log(`  Resolving description hash: ${job.desc_hash.slice(0, 16)}...`);
            const desc = await resolveHash(job.desc_hash);
            if (desc.text) { updates.description_text = desc.text; console.log(`  ✓ Description: "${desc.text.slice(0, 60)}..."`); }
            if (desc.ipfsUrl) updates.description_ipfs_url = desc.ipfsUrl;
            if (desc.fileCid) { updates.description_file_cid = desc.fileCid; console.log(`  ✓ File: ${desc.fileName}`); }
            if (desc.fileName) updates.description_file_name = desc.fileName;
            if (!desc.text && !desc.fileCid) console.log(`  ✗ Could not resolve`);
        }

        // Result
        if (job.result_hash && job.result_hash !== ZERO_HASH && !job.result_text) {
            console.log(`  Resolving result hash: ${job.result_hash.slice(0, 16)}...`);
            const result = await resolveHash(job.result_hash);
            if (result.text) { updates.result_text = result.text; console.log(`  ✓ Result: "${result.text.slice(0, 60)}..."`); }
            if (result.ipfsUrl) updates.result_ipfs_url = result.ipfsUrl;
            if (result.fileCid) { updates.result_file_cid = result.fileCid; console.log(`  ✓ Result file: ${result.fileName}`); }
            if (result.fileName) updates.result_file_name = result.fileName;
            if (!result.text && !result.fileCid) console.log(`  ✗ Could not resolve`);
        }

        if (Object.keys(updates).length > 0) {
            const { error: upErr } = await sb.from('jobs').update(updates).eq('id', job.id);
            if (upErr) console.error(`  DB error: ${upErr.message}`);
            else console.log(`  ✓ Updated ${Object.keys(updates).length} fields`);
        }

        await sleep(2000); // Rate limit protection
    }

    console.log('\nDone!');
}

main().catch(e => console.error('Fatal:', e.message));
