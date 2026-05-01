/**
 * Side-by-side comparison of v1 mainnet (pre-MTONGA) and v2 testnet
 * (post-MTONGA + aggressive optimization). For each opcode print the
 * median actual fee paid by the contract — the number that ends up in
 * `total_fees` on the on-chain transaction record. Outputs a markdown
 * table the README / docs can drop in.
 */
import * as fs from 'fs';
import * as path from 'path';

const V1_FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';        // mainnet v1 JobFactory
const V1_JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';  // mainnet v1 JettonJobFactory

const V2_DEPLOY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'testnet-v2-mtonga.json'), 'utf-8'));
const V2_E2E = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'testnet-v2-mtonga-e2e.json'), 'utf-8'));

const V1_OPCODES: Record<string, string> = {
    '0x00000010': 'CreateJob',
    '0x00000001': 'Fund',
    '0x00000002': 'TakeJob',
    '0x00000003': 'SubmitResult',
    '0x00000004': 'Evaluate',
    '0x00000005': 'Cancel',
    '0x00000007': 'Claim',
    '0x00000008': 'QuitJob',
    '0x00000009': 'SetBudget',
    '0x0000000a': 'SetJettonWallet',
};
const V2_OPCODES: Record<string, string> = {
    '0x8204df3b': 'CreateJob',
    '0x7a90f051': 'Fund',
    '0xba32c6d9': 'TakeJob',
    '0x493e737b': 'SubmitResult',
    '0xa478b965': 'Evaluate',
    '0x18261fbf': 'CancelJob',
    '0xa16c4dc0': 'Claim',
    '0x710b6f59': 'QuitJob',
    '0xb1e059fd': 'SetBudget',
    '0x663a16f6': 'AcceptProvider',
    '0x16b321c2': 'ExtendWindow',
    '0xa7665d4e': 'RetryTransfer',
    '0xbb8c8df3': 'InitJob',
    '0x6c0a1d57': 'CommitSettlement',
};

function fmtTon(nano: bigint): string {
    if (nano === 0n) return '0';
    const s = nano.toString().padStart(10, '0');
    return s.slice(0, -9) + '.' + s.slice(-9).replace(/0+$/, '') || '0';
}

async function fetchTxs(host: string, account: string): Promise<any[]> {
    const all: any[] = [];
    let lastUtime = 9999999999;
    while (all.length < 200) {
        const url = `${host}/transactions?account=${encodeURIComponent(account)}&limit=64&end_utime=${lastUtime}&sort=desc`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) break;
        const d = await r.json() as { transactions?: any[] };
        const batch = d.transactions ?? [];
        if (batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 64) break;
        lastUtime = batch[batch.length - 1].now - 1;
        await new Promise(r => setTimeout(r, 600));
    }
    return all;
}

interface Sample { totalFees: bigint; computeFees: bigint; storageFees: bigint }

async function collectFees(host: string, accounts: string[], opMap: Record<string, string>): Promise<Map<string, Sample[]>> {
    const out = new Map<string, Sample[]>();
    for (const acc of accounts) {
        process.stderr.write(`. ${acc.slice(0, 12)}…\n`);
        const txs = await fetchTxs(host, acc);
        for (const t of txs) {
            const opcode = (t.in_msg?.opcode ?? '') as string;
            const op = opMap[opcode];
            if (!op) continue;
            const total = BigInt(t.total_fees ?? 0);
            const compute = BigInt(t.description?.compute_ph?.gas_fees ?? 0);
            const storage = BigInt(t.description?.storage_ph?.storage_fees_collected ?? 0);
            const fwd = BigInt(t.in_msg?.fwd_fee ?? 0);
            if (!out.has(op)) out.set(op, []);
            out.get(op)!.push({ totalFees: total + fwd, computeFees: compute, storageFees: storage });
        }
        await new Promise(r => setTimeout(r, 800));
    }
    return out;
}

function median(arr: bigint[]): bigint {
    if (arr.length === 0) return 0n;
    const sorted = [...arr].sort((a, b) => Number(a - b));
    return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
    // v2 = testnet
    const v2Accounts = [V2_DEPLOY.factory.address, V2_DEPLOY.jettonFactory.address];
    for (const r of V2_E2E.report ?? []) if (r.jobAddress) v2Accounts.push(r.jobAddress);

    console.log('Reading v2 testnet…');
    const v2 = await collectFees('https://testnet.toncenter.com/api/v3', v2Accounts, V2_OPCODES);

    // v1 = mainnet (pre-MTONGA). Pull factory + sample ~30 most recent jobs created.
    console.log('Reading v1 mainnet factory…');
    // Discover ~30 recent jobs by reading factory transactions and pulling out_msgs targets.
    const factoryTxs = await fetchTxs('https://toncenter.com/api/v3', V1_FACTORY);
    const v1Jobs = new Set<string>();
    for (const t of factoryTxs) {
        for (const m of (t.out_msgs ?? [])) {
            if (m?.destination && v1Jobs.size < 25) v1Jobs.add(m.destination);
        }
        if (v1Jobs.size >= 25) break;
    }
    console.log(`  found ${v1Jobs.size} v1 mainnet job addresses`);
    const v1Accounts = [V1_FACTORY, V1_JETTON_FACTORY, ...Array.from(v1Jobs)];
    const v1 = await collectFees('https://toncenter.com/api/v3', v1Accounts, V1_OPCODES);

    // Build comparison table.
    const ops = new Set<string>([...v1.keys(), ...v2.keys()]);
    const rows = Array.from(ops).sort().map(op => {
        const v1s = v1.get(op) ?? [];
        const v2s = v2.get(op) ?? [];
        return {
            op,
            v1n: v1s.length,
            v1med: median(v1s.map(s => s.totalFees)),
            v2n: v2s.length,
            v2med: median(v2s.map(s => s.totalFees)),
        };
    });

    console.log('\n## Real on-chain gas: v1 mainnet (pre-MTONGA) vs v2 testnet (MTONGA + aggressive)\n');
    console.log('| Op | v1 samples | v1 median total_fees | v2 samples | v2 median total_fees | Ratio |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const r of rows) {
        const ratio = r.v1med > 0n && r.v2med > 0n
            ? (Number(r.v1med) / Number(r.v2med)).toFixed(1) + '×'
            : '—';
        console.log(`| ${r.op} | ${r.v1n} | ${fmtTon(r.v1med)} | ${r.v2n} | ${fmtTon(r.v2med)} | ${ratio} cheaper |`);
    }

    fs.writeFileSync(path.join(__dirname, '..', 'deployments', 'gas-bench-v1-vs-v2.json'),
        JSON.stringify({ runAt: new Date().toISOString(), rows: rows.map(r => ({ ...r, v1med: r.v1med.toString(), v2med: r.v2med.toString() })) }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
