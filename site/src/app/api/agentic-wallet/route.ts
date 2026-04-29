import { NextResponse } from 'next/server';
import { Address } from '@ton/core';

/**
 * GET /api/agentic-wallet?address=<EQ...>
 *
 * Probes the five TON Tech Agentic Wallet get-methods one at a time via
 * toncenter v3. Sequential calls + per-call retry on 429 keep us under
 * the rate limit; running them in parallel triggers spurious throttling
 * that surfaced as "regular v5" badges for real agentic wallets.
 *
 * Each method must return exit_code 0 with a non-empty stack — v3
 * reports a real exit code when a method isn't implemented (unlike v2
 * which sometimes returns an empty stack with exit_code 0). Any failure
 * short-circuits to { isAgenticWallet: false }.
 */

const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const V3 = 'https://toncenter.com/api/v3/runGetMethod';

type StackItem = { type: string; value?: string; cell?: string };
type V3Response = { ok?: boolean; exit_code?: number; stack?: StackItem[]; result?: string; code?: number };

function toHex(n: bigint): string {
    return n.toString(16).padStart(64, '0');
}

async function runGet(address: string, method: string, attempts = 4): Promise<V3Response | null> {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(V3, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
                },
                body: JSON.stringify({ address, method, stack: [] }),
                signal: AbortSignal.timeout(7000),
            });
            const data = await res.json() as V3Response;
            // 429 from toncenter shows up either as HTTP 429 or as an `ok:false`
            // body with `code: 429`. Back off and retry instead of failing.
            if (res.status === 429 || data?.code === 429) {
                await new Promise(r => setTimeout(r, 600 * (i + 1)));
                continue;
            }
            if (!res.ok) return null;
            return data;
        } catch {
            await new Promise(r => setTimeout(r, 400 * (i + 1)));
        }
    }
    return null;
}

function bigFromNum(item: StackItem | undefined): bigint | null {
    if (!item || item.type !== 'num' || !item.value) return null;
    try { return BigInt(item.value); } catch { return null; }
}

function addrFromCell(item: StackItem | undefined): Address | null {
    if (!item || (item.type !== 'cell' && item.type !== 'slice')) return null;
    const raw = item.cell ?? item.value;
    if (!raw) return null;
    try {
        // toncenter v3 returns boc-encoded slice/cell; @ton/core can parse it.
        const { Cell } = require('@ton/core') as typeof import('@ton/core');
        return Cell.fromBase64(raw).beginParse().loadAddress() ?? null;
    } catch { return null; }
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const addressStr = url.searchParams.get('address');
    if (!addressStr) {
        return NextResponse.json({ isAgenticWallet: false, error: 'address query param required' }, { status: 400 });
    }
    let addr: Address;
    try { addr = Address.parse(addressStr); }
    catch {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' },
        });
    }

    // Most distinctive — bail early if missing.
    const pk = await runGet(addressStr, 'get_public_key');
    if (!pk || pk.exit_code !== 0 || !pk.stack?.[0]) {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
        });
    }
    const operatorPubBig = bigFromNum(pk.stack[0]);
    if (operatorPubBig === null) {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
        });
    }

    const origin = await runGet(addressStr, 'get_origin_public_key');
    if (!origin || origin.exit_code !== 0) {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
        });
    }
    const originPubBig = bigFromNum(origin.stack?.[0]);

    const nft = await runGet(addressStr, 'get_nft_data');
    if (!nft || nft.exit_code !== 0 || !nft.stack || nft.stack.length < 4) {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
        });
    }
    // get_nft_data returns: [init, index, collection, owner, content]
    const nftItemIndexBig = bigFromNum(nft.stack[1]);
    const collectionFromNft = addrFromCell(nft.stack[2]);
    const ownerAddress = addrFromCell(nft.stack[3]);
    if (!ownerAddress) {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
        });
    }

    // get_authority_address can be addr_none for SBTs whose authority is the
    // collection itself — that's fine, fall back to the collection.
    const auth = await runGet(addressStr, 'get_authority_address');
    let collectionAddress: Address | null = null;
    if (auth?.exit_code === 0) {
        collectionAddress = addrFromCell(auth.stack?.[0]) ?? collectionFromNft;
    } else {
        collectionAddress = collectionFromNft;
    }

    const revoked = await runGet(addressStr, 'get_revoked_time');
    const revokedAtBig = revoked?.exit_code === 0 ? (bigFromNum(revoked.stack?.[0]) ?? BigInt(0)) : BigInt(0);

    return NextResponse.json(
        {
            isAgenticWallet: true,
            address: addr.toString(),
            ownerAddress: ownerAddress.toString({ bounceable: false }),
            operatorPublicKey: toHex(operatorPubBig),
            originOperatorPublicKey: originPubBig !== null ? toHex(originPubBig) : toHex(operatorPubBig),
            collectionAddress: collectionAddress?.toString() ?? '',
            nftItemIndex: nftItemIndexBig?.toString() ?? '0',
            revokedAt: revokedAtBig.toString(),
            isRevoked: operatorPubBig === BigInt(0),
        },
        { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } },
    );
}
