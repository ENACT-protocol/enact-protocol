'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Bot, Paperclip } from 'lucide-react';

export const AI_EVALUATOR = 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu';
export const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
export const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

export const STATUS_STYLES: Record<string, string> = {
  OPEN: 'border-[#FACC15] text-[#FACC15] bg-[#FACC1520]',
  FUNDED: 'border-[#60A5FA] text-[#60A5FA] bg-[#60A5FA20]',
  TAKEN: 'border-[#3B82F6] text-[#3B82F6] bg-[#3B82F620]',
  SUBMITTED: 'border-[#A78BFA] text-[#A78BFA] bg-[#A78BFA20]',
  COMPLETED: 'border-[#4ADE80] text-[#4ADE80] bg-[#4ADE8020]',
  CANCELLED: 'border-[#6B7280] text-[#6B7280] bg-[#6B728020]',
  DISPUTED: 'border-[#EF4444] text-[#EF4444] bg-[#EF444420]',
  QUIT: 'border-[#EF4444] text-[#EF4444] bg-[#EF444420]',
  CLAIMED: 'border-[#4ADE80] text-[#4ADE80] bg-[#4ADE8020]',
};

export const STATUS_COLORS: Record<string, string> = {
  OPEN: '#FACC15', FUNDED: '#60A5FA', TAKEN: '#3B82F6', SUBMITTED: '#A78BFA',
  COMPLETED: '#4ADE80', CANCELLED: '#6B7280', DISPUTED: '#EF4444', QUIT: '#EF4444', CLAIMED: '#4ADE80',
};


export type ResolvedContent = { text: string | null; source: 'hex' | 'ipfs' | 'hash'; ipfsUrl?: string; file?: { filename: string; mimeType: string; size: number; ipfsUrl?: string } };

export type Job = {
  jobId: number; address: string; type: 'ton' | 'usdt'; state: number; stateName: string;
  client: string; provider: string | null; evaluator: string;
  budget: string; budgetFormatted: string;
  descHash: string; resultHash: string; timeout: number; createdAt: number;
  evalTimeout: number; submittedAt: number; resultType?: number;
  description?: ResolvedContent; resultContent?: ResolvedContent; reasonContent?: ResolvedContent;
  hasFile?: boolean;
  pendingState?: string | null;
  transactions?: Array<{ hash: string; fee: string; utime: number }>;
};

export type ExplorerData = {
  tonJobs: Job[]; jettonJobs: Job[];
  activity?: ActivityEvent[];
  factories: { ton: { address: string; jobCount: number }; jetton: { address: string; jobCount: number } };
  lastUpdated: number;
};

export type ActivityEvent = {
  jobId: number; type: 'ton' | 'usdt'; address: string; event: string; status: string;
  time: number; amount: string; from: string; txHash?: string; txStatus?: 'pending' | 'confirmed' | 'finalized';
};

export function truncAddr(a: string) {
  if (!a || a.length < 16) return a;
  return a.slice(0, 6) + '…' + a.slice(-4);
}

export function tonscanUrl(addr: string) { return `https://tonscan.org/address/${addr}`; }

export function fmtDate(unix: number) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateShort(unix: number) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function fmtTimeout(sec: number) { return sec >= 86400 ? `${Math.round(sec / 86400)}d` : `${Math.round(sec / 3600)}h`; }

export function timeAgo(ts: number) {
  const diff = Math.max(0, Math.floor((Date.now() / 1000) - ts));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h ago`;
}

export function txCount(j: Job): number {
  // Use real tx count if available
  if (j.transactions && j.transactions.length > 0) return j.transactions.length;
  // Fallback estimate when transactions array is unavailable.
  // Note: j.state for CANCELLED=5 so "j.state >= 1" is always true for cancelled jobs.
  // We use submittedAt / provider to infer how far the job actually progressed.
  const wasFunded = j.stateName === 'CANCELLED'
    ? (j.submittedAt > 0 || (j.provider != null && j.provider !== 'none'))
      ? true   // was at least submitted, so definitely funded
      : j.createdAt > 0 // createdAt is set at fund time in contract; 0 means never funded
    : j.state >= 1;
  let n = 1; // initJob
  // setJettonWallet only happens for USDT jobs that actually reached FUNDED state
  if (j.type === 'usdt' && wasFunded) n++; // setJettonWallet
  if (wasFunded) n++; // fund
  if (j.provider && j.provider !== 'none') n++; // take
  if (j.submittedAt) n++; // submit
  if (['COMPLETED', 'DISPUTED'].includes(j.stateName)) n++; // evaluate
  if (j.stateName === 'CANCELLED') n++; // cancel
  return n;
}

export function buildActivity(jobs: Job[], apiActivity?: ActivityEvent[]): ActivityEvent[] {
  // Use server-side opcode-parsed activity events if available
  if (apiActivity && apiActivity.length > 0) {
    return [...apiActivity].sort((a, b) => b.time - a.time);
  }
  // Fallback: build from job data (RPC mode only)
  const events: ActivityEvent[] = [];
  for (const j of jobs) {
    const bf = j.budgetFormatted;
    const txs = [...(j.transactions ?? [])].reverse();
    const createTime = txs[0]?.utime || j.createdAt || 0;
    if (createTime) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Created', status: 'OPEN', time: createTime, amount: bf, from: j.client });
    if (j.state >= 1) {
      const fundTime = txs[1]?.utime || j.createdAt || createTime + 1;
      events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Funded', status: 'FUNDED', time: fundTime, amount: bf, from: j.client });
    }
    if (j.provider && j.provider !== 'none') {
      events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Taken', status: 'FUNDED', time: j.createdAt + 2, amount: '—', from: j.provider });
    }
    if (j.submittedAt) {
      events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Submitted', status: 'SUBMITTED', time: j.submittedAt, amount: bf, from: j.provider ?? '' });
    }
    if (j.stateName === 'COMPLETED') events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Approved', status: 'COMPLETED', time: j.submittedAt + 1, amount: `${bf} → Provider`, from: j.evaluator });
    if (j.stateName === 'CANCELLED') {
      const last = txs[txs.length - 1];
      events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Cancelled', status: 'CANCELLED', time: last?.utime || j.createdAt + j.timeout, amount: `${bf} → Client`, from: j.client, txHash: last?.hash });
    }
    if (j.stateName === 'DISPUTED') events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Rejected', status: 'DISPUTED', time: j.submittedAt + 1, amount: bf, from: j.evaluator });
  }
  return events.sort((a, b) => b.time - a.time);
}

// ─── Components ───

export function Shimmer({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-[#1a1a1a] rounded ${className ?? ''}`} />;
}

export function Badge({ status, pending }: { status: string; pending?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`text-xs px-2 py-0.5 rounded border font-mono explorer-badge ${STATUS_STYLES[status] ?? 'border-[#555] text-[#888]'}`}>{status}</span>
      {pending && <span className="text-xs px-2 py-0.5 rounded bg-[#F59E0B20] border border-[#F59E0B] text-[#F59E0B] font-mono animate-pulse">{pending}</span>}
    </span>
  );
}

export function TonIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="16 18 24 24" fill="none" className="inline-block shrink-0 align-middle" role="img" aria-label="TON">
      <path fillRule="evenodd" clipRule="evenodd" d="M20.199 18.4844H35.9034C36.459 18.4844 37.0142 18.566 37.5944 18.8365C38.2899 19.1606 38.6587 19.6717 38.9171 20.0496C38.9372 20.079 38.956 20.1093 38.9734 20.1403C39.2772 20.6811 39.4338 21.265 39.4338 21.8931C39.4338 22.4899 39.2918 23.1401 38.9734 23.7068L29.0424 40.7665C28.8236 41.1423 28.4209 41.3729 27.986 41.3714C27.5511 41.3698 27.15 41.1364 26.9339 40.759L17.1943 23.7518C16.963 23.3707 16.6183 22.8027 16.558 22.0696C16.5026 21.3956 16.6541 20.7202 16.9928 20.1346C17.3315 19.5489 17.8414 19.0807 18.4547 18.7941C19.1123 18.4868 19.7787 18.4844 20.199 18.4844ZM26.7729 20.9192H20.199C19.7671 20.9192 19.6013 20.9458 19.4854 21C19.3251 21.0748 19.1905 21.1978 19.1005 21.3535C19.0105 21.5092 18.9698 21.6896 18.9846 21.8701C18.9931 21.9737 19.0353 22.0921 19.2842 22.5026L26.7729 35.5785V20.9192ZM29.2077 20.9192V35.643L36.8542 22.5079C36.9405 22.3511 36.999 22.1245 36.999 21.8931C36.999 21.7054 36.9601 21.5424 36.8731 21.3743C36.7818 21.2431 36.7262 21.1736 36.6797 21.126C36.6398 21.0853 36.6091 21.0635 36.5657 21.0433C36.3849 20.959 36.1999 20.9192 35.9034 20.9192H29.2077Z" fill="#0098EA"/>
    </svg>
  );
}

export function UsdtIcon({ size = 16 }: { size?: number }) {
  return <img src="/usdt-icon.svg" alt="USDT" width={size} height={size} style={{ width: size, height: size }} className="inline-block shrink-0 align-middle" />;
}

export function TypeIcon({ type, size = 16 }: { type: 'ton' | 'usdt'; size?: number }) {
  return type === 'ton' ? <TonIcon size={size} /> : <UsdtIcon size={size} />;
}

export function FileClip() {
  return <Paperclip size={14} className="inline-block text-[#555] align-middle" />;
}

export function AIBadge({ addr }: { addr?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-0.5 text-xs text-[#3B82F6] font-mono"><Bot size={12} /> AI</span>
      {addr && <TonscanLink addr={addr} size={12} />}
    </span>
  );
}

export function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={e => { e.stopPropagation(); e.preventDefault(); navigator.clipboard.writeText(hash); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[#555] hover:text-white transition-colors shrink-0 cursor-pointer inline-flex items-center" title="Copy hash" aria-label={copied ? 'Copied' : 'Copy hash'}>
      {copied
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
    </button>
  );
}

export function TonscanLink({ addr, size = 16 }: { addr: string; size?: number }) {
  return (
    <a href={tonscanUrl(addr)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
      className="text-[#555] hover:text-white transition-colors shrink-0 cursor-pointer inline-flex items-center" title="View on TONScan">
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none"><path fill="currentColor" d="M4.14 6.881c0 .199.483.684.84.676.358-.007.88-.452.88-.676 0-.223-.523-.257-.839-.257s-.88.059-.88.257M2.677 5.679c.517.201 1.04.09 1.168-.247s-.189-.774-.706-.976-.958-.225-1.086.113c-.127.337.107.908.624 1.11M6.158 5.432c.128.338.66.425 1.15.188.488-.236.717-.713.59-1.051-.128-.338-.517-.315-1.035-.113s-.833.639-.705.976"/><path fill="currentColor" fillRule="evenodd" d="M1.814.343c.435.267.995.698 1.677 1.284Q4.4 1.469 5 1.468q.597.001 1.494.159C7.18 1.053 7.742.628 8.175.362c.227-.14.437-.247.62-.304.163-.05.414-.097.626.05a.7.7 0 0 1 .249.35q.066.19.093.443c.037.336.035.801-.012 1.414q-.045.581-.157 1.22c.404.768.503 1.627.314 2.557-.186.912-.784 1.726-1.672 2.468C7.368 9.285 6.292 10 4.99 10c-1.29 0-2.57-.733-3.338-1.454C.9 7.84.395 7.143.16 6.342-.114 5.416-.033 4.48.386 3.55q-.121-.67-.156-1.24C.188 1.59.177 1.13.21.824.225.67.254.531.31.411A.75.75 0 0 1 .544.118c.209-.16.462-.127.637-.077.19.054.403.16.633.302M.982.738.96.732A1 1 0 0 0 .93.9c-.025.237-.02.64.024 1.368q.032.56.165 1.262l.022.116-.051.107C.697 4.574.626 5.363.854 6.138c.186.632.595 1.222 1.295 1.88.686.644 1.798 1.257 2.842 1.257 1.033 0 1.938-.567 2.78-1.27.82-.687 1.286-1.368 1.426-2.057.169-.829.063-1.545-.297-2.171l-.066-.116.024-.131q.125-.675.17-1.27c.046-.594.044-1.009.014-1.28a1.5 1.5 0 0 0-.039-.227c-.1.032-.247.103-.45.227-.412.253-.984.686-1.721 1.31L6.7 2.4l-.169-.03C5.88 2.25 5.372 2.193 5 2.193q-.555-.001-1.552.177l-.17.03-.132-.113C2.414 1.65 1.846 1.212 1.435.96A2 2 0 0 0 .982.738" clipRule="evenodd"/></svg>
    </a>
  );
}

export function ClickAddr({ addr, truncate = false }: { addr: string; truncate?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-[#ccc] cursor-pointer hover:text-white transition-colors"
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <span className="text-[#4ADE80]">Copied!</span> : <span className="break-all">{truncate ? truncAddr(addr) : addr}</span>}
      </span>
      <TonscanLink addr={addr} />
    </span>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-3"><span className="text-[#555] w-24 shrink-0 text-sm">{label}</span><span className="text-[#ccc] min-w-0 text-sm">{children}</span></div>;
}

export function LiveTimer({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [timestamp]);
  const diffMs = Math.max(0, now - timestamp);
  const diffS = Math.floor(diffMs / 1000);
  const ago = diffS < 60 ? `${diffS}s ago` : `${Math.floor(diffS / 60)}m ${diffS % 60}s ago`;
  const date = new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <span>{date} ({ago})</span>;
}

export function BudgetDisplay({ job }: { job: Job }) {
  // Note: Number(BigInt(...)) loses precision for values > 2^53 (~9007 TON / ~9B USDT).
  // Acceptable for display since we format to 2 decimals; not suitable for exact arithmetic.
  const num = job.type === 'usdt' ? (Number(BigInt(job.budget)) / 1e6).toFixed(2) : (Number(BigInt(job.budget)) / 1e9).toFixed(2);
  return <span className="inline-flex items-center gap-0.5">{num}<TypeIcon type={job.type} size={14} /></span>;
}

export function ContentBlock({ content, hash }: { content?: ResolvedContent; hash: string }) {
  const [expanded, setExpanded] = useState(false);
  const zeroHash = '0'.repeat(64);
  if (!hash || hash === zeroHash) return <span className="text-[#555]">—</span>;

  const text = content?.text;
  const isLong = !!text && text.length > 200;
  const file = content?.file;
  const isImage = file?.mimeType?.startsWith('image/');
  const isFile = !!file && !isImage;
  const showFilename = file?.filename && file.filename !== 'photo.jpg';

  return (
    <div>
      {/* Text */}
      {text && (
        <div className={`${!expanded && isLong ? 'max-h-[72px] overflow-hidden' : ''}`}>
          <span className="text-[#ccc] whitespace-pre-wrap text-sm">{text}</span>
        </div>
      )}
      {isLong && (
        <button onClick={() => setExpanded(!expanded)} className="text-[#555] hover:text-white transition-colors cursor-pointer mt-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`transform transition-transform ${expanded ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      )}

      {/* Image preview */}
      {isImage && file?.ipfsUrl && (
        <div className={text ? 'mt-3' : ''}>
          <a href={file.ipfsUrl} target="_blank" rel="noopener noreferrer">
            <img src={file.ipfsUrl} alt={file.filename}
              className="max-h-[200px] rounded-lg border border-[#222] cursor-pointer hover:opacity-80 transition-opacity" />
          </a>
          {showFilename && (
            <div className="flex items-center gap-2 mt-1.5 text-xs text-[#555]">
              <span>{file.filename}</span>
              <span>{file.mimeType}</span>
              <a href={file.ipfsUrl} target="_blank" rel="noopener noreferrer" className="text-[#0098EA] hover:underline cursor-pointer">View on IPFS</a>
            </div>
          )}
        </div>
      )}

      {/* Non-image file */}
      {isFile && file?.ipfsUrl && (
        <div className={text ? 'mt-3' : ''}>
          <a href={file.ipfsUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#151515] border border-[#222] rounded-lg text-xs text-[#ccc] hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <div>
              <div className="text-[#ccc]">{file!.filename}</div>
              {file!.size > 0 && <div className="text-[#555]">{(file!.size / 1024).toFixed(1)} KB</div>}
            </div>
          </a>
        </div>
      )}

      {/* No text, no file — show hash */}
      {!text && !file && (
        <span className="text-[#555] font-mono text-xs">Content hash: {hash.slice(0, 16)}... <CopyHash hash={hash} /></span>
      )}

      {/* Copy hash + IPFS link */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="flex-1" />
        {content?.ipfsUrl && (
          <a href={content.ipfsUrl} target="_blank" rel="noopener noreferrer" className="text-[#555] hover:text-white transition-colors cursor-pointer inline-flex items-center" title="View on IPFS">
            <img src="/logos/pinata.jpeg" alt="IPFS" width={14} height={14} className="rounded-sm align-middle" />
          </a>
        )}
        <CopyHash hash={hash} />
      </div>
    </div>
  );
}

const POLL_INTERVAL = 3_000; // Poll every 3s for near-realtime

export function useExplorerData() {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const version = ++requestVersionRef.current;
    try {
      const res = await fetch('/api/explorer', { signal: controller.signal });
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      if (version !== requestVersionRef.current) return;
      setData(json);
      setError(null);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (version !== requestVersionRef.current) return;
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (!controller.signal.aborted && version === requestVersionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    let i: ReturnType<typeof setInterval> = setInterval(fetchData, POLL_INTERVAL);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { setError(null); fetchData(); }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Supabase Realtime: instant updates when indexer writes to DB
    let channel: any = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchData(), 500); // 500ms debounce
    };
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      import('@supabase/supabase-js').then(({ createClient }) => {
        const sb = createClient(supabaseUrl, supabaseKey);
        channel = sb.channel('explorer-live')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, (payload: any) => {
            const row = payload.new;
            console.log('[REALTIME] jobs change:', payload.eventType, row?.job_id ?? '');
            if (row?.address && row?.pending_state) {
              // Pending state set (Processing.../Confirming...) — apply instantly, skip API re-fetch
              setData(prev => {
                if (!prev) return prev;
                const upd = (j: Job) => j.address === row.address ? { ...j, pendingState: row.pending_state } : j;
                return { ...prev, tonJobs: prev.tonJobs.map(upd), jettonJobs: prev.jettonJobs.map(upd) };
              });
            } else {
              // pending_state cleared or state changed — full re-fetch
              debouncedFetch();
            }
          })
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_events' }, (payload: any) => {
            console.log('[REALTIME] new activity:', payload.new?.event ?? '');
            debouncedFetch();
          })
          .subscribe((status: string) => {
            console.log('[REALTIME] subscribe status:', status);
            if (status === 'SUBSCRIBED') {
              clearInterval(i);
              i = setInterval(fetchData, 60_000); // 60s fallback when RT connected
            }
          });
      }).catch(() => {});
    }

    return () => {
      clearInterval(i);
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel) channel.unsubscribe();
    };
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
