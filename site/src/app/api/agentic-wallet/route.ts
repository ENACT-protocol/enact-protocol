import { NextResponse } from 'next/server';
import { Address, TonClient } from '@ton/ton';

/**
 * GET /api/agentic-wallet?address=<EQ...>
 *
 * Probes the standard TON Tech Agentic Wallet get-methods on the
 * supplied address (get_nft_data, get_public_key, get_origin_public_key,
 * get_authority_address, get_revoked_time). Returns AgenticWalletInfo
 * when the methods all succeed and the result shape is consistent,
 * otherwise { isAgenticWallet: false } so the caller can render the
 * address as a regular wallet.
 *
 * The check is conservative — any throw, missing method, or address
 * parse failure short-circuits to "not agentic". Cached at the edge
 * with `s-maxage=300` so the explorer doesn't hammer toncenter while
 * scrolling through long activity feeds.
 */

const ENDPOINT = process.env.TONCENTER_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC';
const API_KEY = process.env.TONCENTER_API_KEY ?? '';

let _client: TonClient | null = null;
function getClient(): TonClient {
    if (!_client) _client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
    return _client;
}

function toHex(n: bigint): string {
    return n.toString(16).padStart(64, '0');
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const addressStr = url.searchParams.get('address');
    if (!addressStr) {
        return NextResponse.json({ isAgenticWallet: false, error: 'address query param required' }, { status: 400 });
    }
    let addr: Address;
    try {
        addr = Address.parse(addressStr);
    } catch {
        return NextResponse.json({ isAgenticWallet: false }, {
            headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' },
        });
    }

    try {
        const client = getClient();
        // First inbound transaction marks the wallet's creation time. v3 API
        // returns it cheaply via `sort=asc&limit=1`; fall back to 0 on error.
        const firstTxUrl = `https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(addr.toString())}&limit=1&sort=asc`;
        const firstTxFetch = fetch(firstTxUrl, {
            headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
            signal: AbortSignal.timeout(5000),
        }).then(r => r.ok ? r.json() as Promise<{ transactions?: Array<{ now?: number }> }> : null).catch(() => null);
        const [pkRes, originRes, nftRes, authRes, revokedRes, firstTxData] = await Promise.all([
            client.runMethod(addr, 'get_public_key'),
            client.runMethod(addr, 'get_origin_public_key'),
            client.runMethod(addr, 'get_nft_data'),
            client.runMethod(addr, 'get_authority_address'),
            client.runMethod(addr, 'get_revoked_time'),
            firstTxFetch,
        ]);
        const createdAt = firstTxData?.transactions?.[0]?.now ?? 0;
        const operatorPubBig = pkRes.stack.readBigNumber();
        const originPubBig = originRes.stack.readBigNumber();
        nftRes.stack.readNumber(); // init flag
        const nftItemIndex = nftRes.stack.readBigNumber();
        const collectionFromNft = nftRes.stack.readAddress();
        const ownerAddress = nftRes.stack.readAddress();
        nftRes.stack.skip(1); // content cell — not surfaced in the API response
        // get_authority_address may be addr_none on SBTs whose authority is
        // the collection itself — readAddress() throws on addr_none, so
        // fall back to the collection address from get_nft_data.
        let collectionAddress: typeof collectionFromNft;
        try {
            collectionAddress = authRes.stack.readAddress() ?? collectionFromNft;
        } catch {
            collectionAddress = collectionFromNft;
        }
        const revokedAt = revokedRes.stack.readBigNumber();

        return NextResponse.json(
            {
                isAgenticWallet: true,
                address: addr.toString(),
                ownerAddress: ownerAddress.toString({ bounceable: false }),
                operatorPublicKey: toHex(operatorPubBig),
                originOperatorPublicKey: toHex(originPubBig),
                collectionAddress: collectionAddress.toString(),
                nftItemIndex: nftItemIndex.toString(),
                revokedAt: revokedAt.toString(),
                isRevoked: operatorPubBig === BigInt(0),
                createdAt,
            },
            { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } },
        );
    } catch {
        return NextResponse.json(
            { isAgenticWallet: false },
            { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } },
        );
    }
}
