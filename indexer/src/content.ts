// Public-facing gateway used in stored ipfsUrl (rendered as a clickable link
// in the UI). gateway.lighthouse.storage is paywalled (402); use ipfs.io as
// the public default. Reads happen via fetchIpfsJson which races multiple
// gateways and ignores this constant.
const IPFS_GW = process.env.IPFS_GATEWAY || process.env.PINATA_GATEWAY || 'https://ipfs.io/ipfs';
const ZERO_HASH = '0'.repeat(64);

export interface ResolvedContent {
  text: string | null;
  ipfsUrl: string | null;
}

function extractText(d: Record<string, any>): string {
  return d.description ?? d.result ?? d.reason ?? JSON.stringify(d);
}

// Race a CID across multiple IPFS gateways. The first 2xx response wins.
// Lighthouse per-account subdomain is fastest; public gateways are backup.
async function fetchIpfsJson(cid: string, timeoutMs = 8000): Promise<Record<string, any> | null> {
  const sub = process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN; // e.g. "numerous-gorilla-z5as6"
  const urls: string[] = [];
  if (sub) urls.push(`https://${sub}.lighthouseweb3.xyz/ipfs/${cid}`);
  urls.push(
    `https://w3s.link/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}`,
    `https://dweb.link/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`,
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const fetches = urls.map(async (u): Promise<Record<string, any>> => {
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return await r.json() as Record<string, any>;
    });
    return await Promise.any(fetches);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function tryLighthouse(hash: string): Promise<ResolvedContent | null> {
  if (!process.env.LIGHTHOUSE_API_KEY) return null;
  try {
    const lhRes = await fetch('https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null', {
      headers: { Authorization: `Bearer ${process.env.LIGHTHOUSE_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!lhRes.ok) return null;
    const data = await lhRes.json() as { fileList?: Array<{ cid: string; fileName: string }> };
    if (!data.fileList?.length) return null;
    const tag = hash.slice(0, 8);
    const match = data.fileList.find(f => f.fileName?.startsWith(`enact-${tag}`) || f.fileName?.startsWith(`enact-file-${tag}`));
    if (!match) return null;
    const ipfsUrl = `${IPFS_GW}/${match.cid}`;
    if (!match.fileName.endsWith('.json')) return { text: null, ipfsUrl };
    const d = await fetchIpfsJson(match.cid);
    if (d) return { text: extractText(d), ipfsUrl };
    return { text: null, ipfsUrl };
  } catch {
    return null;
  }
}

async function tryPinata(hash: string): Promise<ResolvedContent | null> {
  if (!process.env.PINATA_JWT) return null;
  try {
    const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
    if (!pins.rows?.length) return null;
    const cid = pins.rows[0].ipfs_pin_hash;
    const ipfsUrl = `${IPFS_GW}/${cid}`;
    const d = await fetchIpfsJson(cid);
    if (d) return { text: extractText(d), ipfsUrl };
    return { text: null, ipfsUrl };
  } catch {
    return null;
  }
}

export async function resolveContent(hash: string): Promise<ResolvedContent> {
  if (!hash || hash === ZERO_HASH) return { text: null, ipfsUrl: null };

  // 1. Hex decode (legacy: short text stored directly as hex)
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length >= 4) {
      const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
      if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) {
        return { text: bytes, ipfsUrl: null };
      }
    }
  } catch {}

  // 2. Lighthouse (primary provider in the SDK + bot)
  const lh = await tryLighthouse(hash);
  if (lh) return lh;

  // 3. Pinata (fallback)
  const pinata = await tryPinata(hash);
  if (pinata) return pinata;

  return { text: null, ipfsUrl: null };
}
