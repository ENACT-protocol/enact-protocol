'use client';

import { useState, useEffect, useMemo } from 'react';
import Header from '../../components/Header';
import Footer from '../../components/Footer';

const AI_EVALUATOR = 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu';
const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

const STATUS_STYLES: Record<string, string> = {
  OPEN: 'border-[#555] text-[#888]',
  FUNDED: 'border-[#0088CC] text-[#0088CC] bg-[#0088CC20]',
  SUBMITTED: 'border-[#F59E0B] text-[#F59E0B] bg-[#F59E0B20]',
  COMPLETED: 'border-[#4ADE80] text-[#4ADE80] bg-[#4ADE8020]',
  CANCELLED: 'border-[#EF4444] text-[#EF4444] bg-[#EF444420]',
  DISPUTED: 'border-[#F97316] text-[#F97316] bg-[#F9731620]',
};

function truncAddr(a: string) {
  if (!a || a.length < 16) return a;
  return a.slice(0, 8) + '...' + a.slice(-4);
}

function tonviewerUrl(addr: string) {
  return `https://tonviewer.com/${addr}`;
}

function timeAgo(ts: number) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function fmtDate(unix: number) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTimeout(sec: number) {
  if (sec >= 86400) return `${Math.round(sec / 86400)}d`;
  return `${Math.round(sec / 3600)}h`;
}

function Shimmer({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-[#1a1a1a] rounded ${className ?? ''}`} />;
}

function Badge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-mono ${STATUS_STYLES[status] ?? 'border-[#555] text-[#888]'}`}>
      {status}
    </span>
  );
}

function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`hover:text-[#0098EA] transition-colors ${className ?? ''}`}>
      {children}<span className="text-[#555] ml-1 text-xs">↗</span>
    </a>
  );
}

type Job = {
  jobId: number; address: string; type: 'ton' | 'usdt'; state: number; stateName: string;
  client: string; provider: string | null; evaluator: string;
  budget: string; budgetFormatted: string; budgetTon: string;
  descHash: string; resultHash: string; timeout: number; createdAt: number;
  evalTimeout: number; submittedAt: number;
};

type ExplorerData = {
  tonJobs: Job[]; jettonJobs: Job[];
  factories: { ton: { address: string; jobCount: number }; jetton: { address: string; jobCount: number } };
  lastUpdated: number;
};

type Tab = 'all' | 'ton' | 'usdt' | 'active' | 'completed';

function JobDetail({ job }: { job: Job }) {
  const [showTech, setShowTech] = useState(false);
  const isAI = job.evaluator === AI_EVALUATOR;
  const zeroHash = '0'.repeat(64);

  return (
    <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-b-xl px-6 py-5 -mt-px">
      <div className="flex items-center gap-3 mb-5">
        <span className="font-serif italic text-2xl text-white">#{job.jobId}</span>
        <Badge status={job.stateName} />
        <span className="text-xs text-[#555] font-mono">{job.type.toUpperCase()}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
        {/* Overview */}
        <div>
          <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Overview</div>
          <div className="space-y-2">
            <Row label="Address"><ExtLink href={tonviewerUrl(job.address)} className="font-mono text-xs break-all">{job.address}</ExtLink></Row>
            <Row label="Factory">{job.type === 'ton' ? 'JobFactory (TON)' : 'JettonJobFactory (USDT)'}</Row>
            <Row label="Status"><Badge status={job.stateName} /></Row>
            <Row label="Budget"><span className="text-white font-medium">{job.budgetFormatted}</span></Row>
            <Row label="Created">{fmtDate(job.createdAt)}</Row>
            <Row label="Timeout">{fmtTimeout(job.timeout)} (eval: {fmtTimeout(job.evalTimeout)})</Row>
          </div>
        </div>

        {/* Participants */}
        <div>
          <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Participants</div>
          <div className="space-y-2">
            <Row label="Client"><ExtLink href={tonviewerUrl(job.client)} className="font-mono text-xs">{truncAddr(job.client)}</ExtLink></Row>
            <Row label="Provider">
              {job.provider && job.provider !== 'none'
                ? <ExtLink href={tonviewerUrl(job.provider)} className="font-mono text-xs">{truncAddr(job.provider)}</ExtLink>
                : <span className="text-[#555]">—</span>}
            </Row>
            <Row label="Evaluator">
              <ExtLink href={tonviewerUrl(job.evaluator)} className="font-mono text-xs">{truncAddr(job.evaluator)}</ExtLink>
              {isAI && <span className="ml-1.5 text-xs" title="AI Evaluator">🤖</span>}
            </Row>
          </div>
        </div>
      </div>

      {/* Content hashes */}
      <div className="mt-5 space-y-2 text-sm">
        <div className="text-[#555] text-xs font-mono mb-2 uppercase tracking-wider">Content</div>
        <Row label="Description">{job.descHash !== zeroHash ? <span className="font-mono text-xs text-[#888] break-all">{job.descHash.slice(0, 24)}...</span> : <span className="text-[#555]">—</span>}</Row>
        <Row label="Result">{job.resultHash !== zeroHash ? <span className="font-mono text-xs text-[#888] break-all">{job.resultHash.slice(0, 24)}...</span> : <span className="text-[#555]">—</span>}</Row>
      </div>

      {/* Technical Details */}
      <button
        onClick={() => setShowTech(!showTech)}
        className="mt-4 flex items-center gap-2 text-xs text-[#555] hover:text-[#888] transition-colors font-mono"
      >
        <span className={`transform transition-transform ${showTech ? 'rotate-90' : ''}`}>▶</span>
        Technical Details
      </button>
      {showTech && (
        <div className="mt-3 bg-[#0a0a0a] rounded-lg p-4 text-xs text-[#666] font-mono space-y-1.5">
          <TechRow label="jobId">{job.jobId}</TechRow>
          <TechRow label="state">{job.state} ({job.stateName})</TechRow>
          <TechRow label="descHash"><span className="break-all">{job.descHash}</span></TechRow>
          <TechRow label="resultHash"><span className="break-all">{job.resultHash}</span></TechRow>
          <TechRow label="timeout">{job.timeout}</TechRow>
          <TechRow label="evalTimeout">{job.evalTimeout}</TechRow>
          <TechRow label="createdAt">{job.createdAt}</TechRow>
          <TechRow label="submittedAt">{job.submittedAt}</TechRow>
          <TechRow label="budget (raw)">{job.budget}</TechRow>
          <TechRow label="factory">{job.type === 'ton' ? FACTORY : JETTON_FACTORY}</TechRow>
          <div className="pt-2 mt-2 border-t border-[#1a1a1a] text-[#555]">
            Storage: Main Cell (jobId · factory · client · provider · state) → Details (evaluator · budget · descHash · resultHash) → Extension (timeout · createdAt · evalTimeout · submittedAt)
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[#555] w-24 shrink-0">{label}</span>
      <span className="text-[#ccc] min-w-0">{children}</span>
    </div>
  );
}

function TechRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[#444] w-28 shrink-0">{label}</span>
      <span className="text-[#666]">{children}</span>
    </div>
  );
}

export default function ExplorerPage() {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchResult, setSearchResult] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'id' | 'status' | 'budget'>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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

  const allJobs = useMemo(() => {
    if (!data) return [];
    return [...data.tonJobs, ...data.jettonJobs];
  }, [data]);

  const filteredJobs = useMemo(() => {
    let jobs = allJobs;
    if (tab === 'ton') jobs = jobs.filter(j => j.type === 'ton');
    else if (tab === 'usdt') jobs = jobs.filter(j => j.type === 'usdt');
    else if (tab === 'active') jobs = jobs.filter(j => ['OPEN', 'FUNDED', 'SUBMITTED'].includes(j.stateName));
    else if (tab === 'completed') jobs = jobs.filter(j => j.stateName === 'COMPLETED');

    jobs = [...jobs].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'id') cmp = a.jobId - b.jobId;
      else if (sortBy === 'status') cmp = a.state - b.state;
      else if (sortBy === 'budget') cmp = Number(BigInt(a.budget) - BigInt(b.budget));
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return jobs;
  }, [allJobs, tab, sortBy, sortDir]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, ton: 0, usdt: 0, completed: 0 };
    return {
      total: allJobs.length,
      ton: data.tonJobs.length,
      usdt: data.jettonJobs.length,
      completed: allJobs.filter(j => j.stateName === 'COMPLETED').length,
    };
  }, [data, allJobs]);

  const handleSearch = () => {
    if (!search.trim() || !data) { setSearchResult(null); return; }
    const q = search.trim();
    // Check factories
    if (q.startsWith(FACTORY.slice(0, 8)) || q === FACTORY) { setSearchResult('factory_ton'); return; }
    if (q.startsWith(JETTON_FACTORY.slice(0, 8)) || q === JETTON_FACTORY) { setSearchResult('factory_jetton'); return; }
    // Check jobs
    const job = allJobs.find(j => j.address === q || j.address.startsWith(q));
    if (job) { setExpandedJob(job.address); setSearchResult(null); return; }
    setSearchResult('not_found');
  };

  const toggleSort = (col: 'id' | 'status' | 'budget') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All Jobs' },
    { key: 'ton', label: 'TON' },
    { key: 'usdt', label: 'USDT' },
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' },
  ];

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <h1 className="font-serif text-3xl sm:text-4xl text-white mb-2">Explorer</h1>
        <p className="text-[#888] text-sm mb-8">Browse ENACT Protocol jobs and factories on TON Mainnet</p>

        {/* Search */}
        <div className="mb-8">
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchResult(null); }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search by job or factory address..."
              className="flex-1 bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#555] font-mono focus:outline-none focus:border-[#0098EA] transition-colors"
            />
            <button onClick={handleSearch} className="bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-[#888] hover:text-white hover:border-[#0098EA] transition-colors">
              Search
            </button>
          </div>
          {searchResult === 'not_found' && (
            <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">
              Address not found in ENACT Protocol. This explorer tracks only ENACT contracts.
              <div className="mt-1 text-[#555]">Looking for a wallet? Try <a href="https://tonviewer.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">tonviewer.com</a></div>
            </div>
          )}
          {searchResult?.startsWith('factory_') && (
            <FactoryDetail
              type={searchResult === 'factory_ton' ? 'ton' : 'usdt'}
              data={data}
              onClose={() => setSearchResult(null)}
            />
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[1,2,3,4].map(i => <Shimmer key={i} className="h-20 rounded-xl" />)}
            </div>
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <Shimmer key={i} className="h-12" />)}
            </div>
          </div>
        ) : error ? (
          <div className="text-red-400 bg-[#111] border border-[#222] rounded-xl p-6 text-center">
            Failed to load: {error}
          </div>
        ) : data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              {[
                { label: 'Total', value: stats.total },
                { label: 'TON Jobs', value: stats.ton },
                { label: 'USDT Jobs', value: stats.usdt },
                { label: 'Completed', value: stats.completed },
              ].map(s => (
                <div key={s.label} className="bg-[#111] border border-[#222] rounded-xl p-4">
                  <div className="text-[#555] text-xs font-mono uppercase">{s.label}</div>
                  <div className="text-white text-2xl font-semibold mt-1">{s.value}</div>
                </div>
              ))}
            </div>
            <div className="text-[#444] text-xs font-mono mb-6">
              Last updated: {timeAgo(data.lastUpdated)} · Auto-refreshes every 30s
            </div>

            {/* Factories */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
              {[
                { label: 'JobFactory', type: 'ton' as const, addr: data.factories.ton.address, count: data.factories.ton.jobCount },
                { label: 'JettonJobFactory', type: 'usdt' as const, addr: data.factories.jetton.address, count: data.factories.jetton.jobCount },
              ].map(f => (
                <div key={f.label} className="bg-[#111] border border-[#222] rounded-xl p-4 hover:border-[#333] transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium">{f.label}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-[#888] text-sm">{f.count} jobs</span>
                      <a href={tonviewerUrl(f.addr)} target="_blank" rel="noopener noreferrer" className="text-[#555] hover:text-[#0098EA] text-xs">↗</a>
                    </div>
                  </div>
                  <div className="font-mono text-xs text-[#555] truncate">{f.addr}</div>
                </div>
              ))}
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4 overflow-x-auto">
              {tabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors whitespace-nowrap ${
                    tab === t.key
                      ? 'bg-[#1a1a1a] text-white border border-[#333]'
                      : 'text-[#888] hover:text-white hover:bg-[#111]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Jobs Table */}
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a1a] text-[#555] text-xs font-mono uppercase">
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('id')}>
                      # {sortBy === 'id' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="text-left px-4 py-3 hidden sm:table-cell">Address</th>
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('status')}>
                      Status {sortBy === 'status' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('budget')}>
                      Budget {sortBy === 'budget' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="text-left px-4 py-3 hidden sm:table-cell">Type</th>
                    <th className="text-left px-4 py-3 hidden md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-[#555] py-8">No jobs match filter</td></tr>
                  )}
                  {filteredJobs.map(job => (
                    <JobRow
                      key={job.address}
                      job={job}
                      expanded={expandedJob === job.address}
                      onToggle={() => setExpandedJob(expandedJob === job.address ? null : job.address)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function JobRow({ job, expanded, onToggle }: { job: Job; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-[#1a1a1a] cursor-pointer transition-colors ${expanded ? 'bg-[#151515]' : 'hover:bg-[#151515]'}`}
      >
        <td className="px-4 py-3 text-white font-medium">{job.jobId}</td>
        <td className="px-4 py-3 font-mono text-xs text-[#888] hidden sm:table-cell">{truncAddr(job.address)}</td>
        <td className="px-4 py-3"><Badge status={job.stateName} /></td>
        <td className="px-4 py-3 text-[#ccc]">{job.budgetFormatted}</td>
        <td className="px-4 py-3 text-[#555] text-xs font-mono hidden sm:table-cell">{job.type.toUpperCase()}</td>
        <td className="px-4 py-3 text-[#555] text-xs hidden md:table-cell">{fmtDate(job.createdAt)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="p-0">
            <JobDetail job={job} />
          </td>
        </tr>
      )}
    </>
  );
}

function FactoryDetail({ type, data, onClose }: { type: 'ton' | 'usdt'; data: ExplorerData | null; onClose: () => void }) {
  if (!data) return null;
  const f = type === 'ton' ? data.factories.ton : data.factories.jetton;
  const label = type === 'ton' ? 'JobFactory' : 'JettonJobFactory';
  const jobs = type === 'ton' ? data.tonJobs : data.jettonJobs;

  return (
    <div className="mt-3 bg-[#111] border border-[#222] rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white text-lg font-medium">{label}</h3>
        <button onClick={onClose} className="text-[#555] hover:text-white text-sm">✕</button>
      </div>
      <div className="space-y-2 text-sm mb-4">
        <Row label="Address"><ExtLink href={tonviewerUrl(f.address)} className="font-mono text-xs break-all">{f.address}</ExtLink></Row>
        <Row label="Type">{type === 'ton' ? 'TON Escrow' : 'USDT/Jetton Escrow'}</Row>
        <Row label="Total Jobs">{f.jobCount}</Row>
        <Row label="Network">Mainnet</Row>
      </div>
      <div className="text-[#555] text-xs font-mono uppercase mb-2">Jobs ({jobs.length})</div>
      <div className="space-y-1">
        {jobs.map(j => (
          <div key={j.address} className="flex items-center gap-3 text-xs py-1.5 border-b border-[#1a1a1a]">
            <span className="text-white w-8">#{j.jobId}</span>
            <Badge status={j.stateName} />
            <span className="text-[#888]">{j.budgetFormatted}</span>
            <span className="font-mono text-[#555] hidden sm:inline">{truncAddr(j.address)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
