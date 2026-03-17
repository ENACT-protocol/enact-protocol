'use client';

import { useState, useEffect, useMemo } from 'react';

export const AI_EVALUATOR = 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu';
export const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
export const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

export const STATUS_STYLES: Record<string, string> = {
  OPEN: 'border-[#4ADE80] text-[#4ADE80] bg-[#4ADE8020]',
  FUNDED: 'border-[#F59E0B] text-[#F59E0B] bg-[#F59E0B20]',
  SUBMITTED: 'border-[#3B82F6] text-[#3B82F6] bg-[#3B82F620]',
  COMPLETED: 'border-[#4ADE80] text-[#4ADE80] bg-[#4ADE8020]',
  CANCELLED: 'border-[#6B7280] text-[#6B7280] bg-[#6B728020]',
  DISPUTED: 'border-[#EF4444] text-[#EF4444] bg-[#EF444420]',
};

export const STATUS_DOTS: Record<string, string> = {
  OPEN: 'text-[#4ADE80]', FUNDED: 'text-[#F59E0B]', SUBMITTED: 'text-[#3B82F6]',
  COMPLETED: 'text-[#4ADE80]', CANCELLED: 'text-[#6B7280]', DISPUTED: 'text-[#EF4444]',
};

export type Job = {
  jobId: number; address: string; type: 'ton' | 'usdt'; state: number; stateName: string;
  client: string; provider: string | null; evaluator: string;
  budget: string; budgetFormatted: string; budgetTon: string;
  descHash: string; resultHash: string; timeout: number; createdAt: number;
  evalTimeout: number; submittedAt: number;
};

export type ExplorerData = {
  tonJobs: Job[]; jettonJobs: Job[];
  factories: { ton: { address: string; jobCount: number }; jetton: { address: string; jobCount: number } };
  lastUpdated: number;
};

export type ActivityEvent = {
  jobId: number; type: 'ton' | 'usdt'; address: string; event: string; status: string; time: number; budget?: string;
};

export function truncAddr(a: string, long = false) {
  if (!a || a.length < 16) return a;
  return long ? a.slice(0, 12) + '...' + a.slice(-6) : a.slice(0, 8) + '...' + a.slice(-4);
}

export function tonscanUrl(addr: string) {
  return `https://tonscan.org/address/${addr}`;
}

export function fmtDate(unix: number) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateShort(unix: number) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function fmtTimeout(sec: number) {
  if (sec >= 86400) return `${Math.round(sec / 86400)}d`;
  return `${Math.round(sec / 3600)}h`;
}

export function timeAgo(ts: number) {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function decodeHexContent(hash: string): string | null {
  if (!hash || hash === '0'.repeat(64)) return null;
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length < 4) return null;
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substring(i, i + 2), 16));
    const text = String.fromCharCode(...bytes).replace(/\0/g, '');
    if (/^[\x20-\x7E\n\r\t]+$/.test(text) && text.length > 2) return text;
  } catch {}
  return null;
}

export function buildActivity(jobs: Job[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const j of jobs) {
    if (j.createdAt) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Created', status: 'OPEN', time: j.createdAt, budget: j.budgetFormatted });
    if (j.state >= 1 && j.createdAt) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Funded', status: 'FUNDED', time: j.createdAt + 1, budget: j.budgetFormatted });
    if (j.submittedAt) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Submitted', status: 'SUBMITTED', time: j.submittedAt });
    if (j.stateName === 'COMPLETED' && j.submittedAt) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Completed', status: 'COMPLETED', time: j.submittedAt + 1, budget: j.budgetFormatted });
    if (j.stateName === 'CANCELLED') events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Cancelled', status: 'CANCELLED', time: j.createdAt + j.timeout });
    if (j.stateName === 'DISPUTED' && j.submittedAt) events.push({ jobId: j.jobId, type: j.type, address: j.address, event: 'Disputed', status: 'DISPUTED', time: j.submittedAt + 1 });
  }
  return events.sort((a, b) => b.time - a.time);
}

// ─── Components ───

export function Shimmer({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-[#1a1a1a] rounded ${className ?? ''}`} />;
}

export function Badge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-mono ${STATUS_STYLES[status] ?? 'border-[#555] text-[#888]'}`}>
      {status}
    </span>
  );
}

export function TonIcon({ size = 16 }: { size?: number }) {
  return <img src="/ton-icon.svg" alt="TON" width={size} height={size} className="inline-block rounded-full" />;
}

export function UsdtIcon({ size = 16 }: { size?: number }) {
  return <img src="/usdt-icon.svg" alt="USDT" width={size} height={size} className="inline-block rounded-full" />;
}

export function TypeIcon({ type, size = 16 }: { type: 'ton' | 'usdt'; size?: number }) {
  return type === 'ton' ? <TonIcon size={size} /> : <UsdtIcon size={size} />;
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => { e.stopPropagation(); e.preventDefault(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[#555] hover:text-white transition-colors" title="Copy address"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      )}
    </button>
  );
}

export function TonscanLink({ addr }: { addr: string }) {
  return (
    <a href={tonscanUrl(addr)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
      className="text-[#555] hover:text-white transition-colors" title="View on TONScan">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </a>
  );
}

export function AddrWithActions({ addr, truncate = false, long = false }: { addr: string; truncate?: boolean; long?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-[#ccc]">{truncate ? truncAddr(addr, long) : addr}</span>
      <TonscanLink addr={addr} />
      <CopyButton text={addr} />
    </span>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[#555] w-24 shrink-0 text-sm">{label}</span>
      <span className="text-[#ccc] min-w-0 text-sm">{children}</span>
    </div>
  );
}

export function LiveTimer({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const diff = Math.floor((now - timestamp) / 1000);
  const ago = diff < 5 ? 'just now' : diff < 60 ? `${diff}s ago` : `${Math.floor(diff / 60)}m ${diff % 60}s ago`;
  const date = new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return <span>{date} ({ago})</span>;
}

export function BudgetDisplay({ job }: { job: Job }) {
  const num = job.type === 'usdt'
    ? (Number(BigInt(job.budget)) / 1e6).toFixed(2)
    : (Number(BigInt(job.budget)) / 1e9).toFixed(2);
  return (
    <span className="inline-flex items-center gap-1">
      {num} <TypeIcon type={job.type} size={14} />
    </span>
  );
}

export function ContentDisplay({ hash, label }: { hash: string; label: string }) {
  const zeroHash = '0'.repeat(64);
  if (!hash || hash === zeroHash) return <span className="text-[#555]">—</span>;

  const decoded = decodeHexContent(hash);
  if (decoded) return <span className="text-[#ccc] whitespace-pre-wrap">{decoded}</span>;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[#555] font-mono text-xs">On-chain hash: {hash.slice(0, 20)}...</span>
      <CopyButton text={hash} />
    </div>
  );
}

export function useExplorerData() {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/explorer');
      if (!res.ok) throw new Error('Failed to fetch');
      const d = await res.json();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  return { data, loading, error };
}
