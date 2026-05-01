/**
 * Reads every transaction sent to the freshly deployed MTONGA factories
 * on TON testnet (deployments/testnet-v2-mtonga.json) and the e2e job
 * addresses (deployments/testnet-v2-mtonga-e2e.json). For each tx prints
 * total_fees, compute_phase gas, action_phase fwd, storage_phase storage,
 * and the original incoming msg value. Output is a markdown table that
 * can be dropped into the README so users see the real numbers.
 */
import * as fs from 'fs';
import * as path from 'path';

const DEPLOY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'testnet-v2-mtonga.json'), 'utf-8'));
const E2E = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'testnet-v2-mtonga-e2e.json'), 'utf-8'));

const TONCENTER = 'https://testnet.toncenter.com/api/v3';

// Map opcode → human label so the output is readable.
// TON Job opcodes (see contracts/job.tolk + struct definitions).
// v1 simple opcodes (master / mainnet)
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
// v2 CRC32 opcodes (testnet branch)
const V2_OPCODES: Record<string, string> = {
    '0x8204df3b': 'CreateJob',
    '0x7a90f051': 'Fund',
    '0xba32c6d9': 'TakeJob',
    '0x493e737b': 'SubmitResult',
    '0xa478b965': 'Evaluate',
    '0x18261fbf': 'CancelJob',
    '0xa16c4dc0': 'ClaimJob',
    '0x710b6f59': 'QuitJob',
    '0xb1e059fd': 'SetBudget',
    '0x663a16f6': 'AcceptProvider',
    '0x16b321c2': 'ExtendWindow',
    '0xa7665d4e': 'RetryTransfer',
    '0xbb8c8df3': 'InitJob',
    '0x6c0a1d57': 'CommitSettlement',
};
const OPCODES: Record<string, string> = { ...V1_OPCODES, ...V2_OPCODES, '': '(no body)', 'undefined': '(no body)' };

function fmtTon(nano: string | number | bigint): string {
    const n = typeof nano === 'bigint' ? nano : BigInt(nano ?? 0);
    if (n === 0n) return '0';
    // 9 decimals
    const s = n.toString().padStart(10, '0');
    return s.slice(0, -9) + '.' + s.slice(-9).replace(/0+$/, '') || '0';
}

async function fetchTxs(account: string): Promise<any[]> {
    // Paginate via v3.
    const all: any[] = [];
    let lastUtime = 9999999999;
    while (true) {
        const url = `${TONCENTER}/transactions?account=${encodeURIComponent(account)}&limit=64&end_utime=${lastUtime}&sort=desc`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) {
            console.warn(`  fetch ${account}: ${r.status}`);
            return all;
        }
        const d = await r.json() as { transactions?: any[] };
        const batch = d.transactions ?? [];
        if (batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 64) break;
        lastUtime = batch[batch.length - 1].now - 1;
    }
    return all;
}

interface Row {
    op: string;
    account: 'factory' | 'job' | 'jetton-factory';
    scenario: string;
    inMsgValue: bigint;       // attached TON
    totalFees: bigint;          // total deducted from value
    computeFees: bigint;        // gas
    storageFees: bigint;        // rent
    actionFees: bigint;         // fwd of outbound actions
    excessReturned: bigint;     // inMsgValue - totalFees - outbound msg values  (approx)
}

async function rowsForJob(jobAddr: string, scenario: string): Promise<Row[]> {
    const txs = await fetchTxs(jobAddr);
    const rows: Row[] = [];
    for (const t of txs) {
        if (!t.in_msg) continue;
        const opcode = (t.in_msg.opcode ?? '') as string;
        const op = OPCODES[opcode] ?? opcode;
        const inVal = BigInt(t.in_msg.value ?? 0);
        const total = BigInt(t.total_fees ?? 0);
        const compute = BigInt(t.description?.compute_ph?.gas_fees ?? 0);
        const storage = BigInt(t.description?.storage_ph?.storage_fees_collected ?? 0);
        const action = BigInt(t.description?.action?.total_action_fees ?? t.description?.action_ph?.total_action_fees ?? 0);
        const fwd = BigInt(t.in_msg?.fwd_fee ?? 0);
        const outValue = (t.out_msgs ?? []).reduce((a: bigint, m: any) => a + BigInt(m.value ?? 0), 0n);
        const excess = inVal - outValue - total;
        rows.push({
            op,
            account: 'job',
            scenario,
            inMsgValue: inVal,
            totalFees: total + fwd,
            computeFees: compute,
            storageFees: storage,
            actionFees: action,
            excessReturned: excess > 0n ? excess : 0n,
        });
    }
    return rows;
}

async function rowsForFactory(addr: string, label: 'factory' | 'jetton-factory'): Promise<Row[]> {
    const txs = await fetchTxs(addr);
    const rows: Row[] = [];
    for (const t of txs) {
        if (!t.in_msg) continue;
        const opcode = (t.in_msg.opcode ?? '') as string;
        const op = OPCODES[opcode] ?? opcode;
        const inVal = BigInt(t.in_msg.value ?? 0);
        const total = BigInt(t.total_fees ?? 0);
        const compute = BigInt(t.description?.compute_ph?.gas_fees ?? 0);
        const storage = BigInt(t.description?.storage_ph?.storage_fees_collected ?? 0);
        const action = BigInt(t.description?.action?.total_action_fees ?? t.description?.action_ph?.total_action_fees ?? 0);
        const outValue = (t.out_msgs ?? []).reduce((a: bigint, m: any) => a + BigInt(m.value ?? 0), 0n);
        const excess = inVal - outValue - total;
        rows.push({
            op, account: label, scenario: 'factory tx',
            inMsgValue: inVal,
            totalFees: total,
            computeFees: compute,
            storageFees: storage,
            actionFees: action,
            excessReturned: excess > 0n ? excess : 0n,
        });
    }
    return rows;
}

async function main() {
    const allRows: Row[] = [];

    console.log(`\nReading factory ${DEPLOY.factory.address}…`);
    allRows.push(...(await rowsForFactory(DEPLOY.factory.address, 'factory')));
    await new Promise(r => setTimeout(r, 1500));

    console.log(`Reading jetton factory ${DEPLOY.jettonFactory.address}…`);
    allRows.push(...(await rowsForFactory(DEPLOY.jettonFactory.address, 'jetton-factory')));
    await new Promise(r => setTimeout(r, 1500));

    for (const r of E2E.report ?? []) {
        if (!r.jobAddress) continue;
        console.log(`Reading job ${r.scenario}: ${r.jobAddress}…`);
        allRows.push(...(await rowsForJob(r.jobAddress, r.scenario)));
        await new Promise(r => setTimeout(r, 1500));
    }

    // Aggregate per opcode (median of totalFees)
    const byOp: Map<string, Row[]> = new Map();
    for (const row of allRows) {
        const k = row.op;
        if (!byOp.has(k)) byOp.set(k, []);
        byOp.get(k)!.push(row);
    }

    console.log(`\n--- raw transactions: ${allRows.length} ---\n`);
    console.log('| op | scenario | in_value | total_fees | compute | action | storage |');
    console.log('|---|---|---:|---:|---:|---:|---:|');
    for (const r of allRows) {
        console.log(`| ${r.op} | ${r.scenario} | ${fmtTon(r.inMsgValue)} | ${fmtTon(r.totalFees)} | ${fmtTon(r.computeFees)} | ${fmtTon(r.actionFees)} | ${fmtTon(r.storageFees)} |`);
    }

    console.log('\n--- median per opcode ---\n');
    console.log('| op | n | median total_fees | median compute |');
    console.log('|---|---:|---:|---:|');
    const sorted = [...byOp.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [op, list] of sorted) {
        const totals = list.map(r => r.totalFees).sort((a, b) => Number(a - b));
        const computes = list.map(r => r.computeFees).sort((a, b) => Number(a - b));
        const med = (arr: bigint[]) => arr[Math.floor(arr.length / 2)];
        console.log(`| ${op} | ${list.length} | ${fmtTon(med(totals))} | ${fmtTon(med(computes))} |`);
    }

    // Save raw
    const out = path.join(__dirname, '..', 'deployments', 'testnet-v2-mtonga-gas-bench.json');
    fs.writeFileSync(out, JSON.stringify({
        runAt: new Date().toISOString(),
        rows: allRows.map(r => ({
            ...r,
            inMsgValue: r.inMsgValue.toString(),
            totalFees: r.totalFees.toString(),
            computeFees: r.computeFees.toString(),
            storageFees: r.storageFees.toString(),
            actionFees: r.actionFees.toString(),
            excessReturned: r.excessReturned.toString(),
        })),
    }, null, 2));
    console.log(`\nsaved: ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
