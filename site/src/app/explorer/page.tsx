'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import {
  FACTORY, JETTON_FACTORY, Job, useExplorerData,
  Badge, Shimmer, TypeIcon, TonIcon, UsdtIcon,
  AddrWithActions, LiveTimer, BudgetDisplay,
  truncAddr, fmtDateShort, tonscanUrl,
} from './shared';

type Tab = 'all' | 'ton' | 'usdt' | 'active' | 'completed';

export default function ExplorerPage() {
  const { data, loading, error } = useExplorerData();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [searchError, setSearchError] = useState(false);
  const [sortBy, setSortBy] = useState<'id' | 'status' | 'budget'>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const allJobs = useMemo(() => data ? [...data.tonJobs, ...data.jettonJobs] : [], [data]);

  const filteredJobs = useMemo(() => {
    let jobs = allJobs;
    if (tab === 'ton') jobs = jobs.filter(j => j.type === 'ton');
    else if (tab === 'usdt') jobs = jobs.filter(j => j.type === 'usdt');
    else if (tab === 'active') jobs = jobs.filter(j => ['OPEN', 'FUNDED', 'SUBMITTED'].includes(j.stateName));
    else if (tab === 'completed') jobs = jobs.filter(j => j.stateName === 'COMPLETED');

    return [...jobs].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'id') cmp = a.jobId - b.jobId || (a.type === 'ton' ? -1 : 1);
      else if (sortBy === 'status') cmp = a.state - b.state;
      else if (sortBy === 'budget') cmp = Number(BigInt(a.budget) - BigInt(b.budget));
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [allJobs, tab, sortBy, sortDir]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, ton: 0, usdt: 0, completed: 0 };
    return {
      total: allJobs.length, ton: data.tonJobs.length, usdt: data.jettonJobs.length,
      completed: allJobs.filter(j => j.stateName === 'COMPLETED').length,
    };
  }, [data, allJobs]);

  const handleSearch = () => {
    if (!search.trim() || !data) return;
    const q = search.trim();
    setSearchError(false);
    if (q === FACTORY || FACTORY.startsWith(q) && q.length >= 8) { router.push(`/explorer/factory/${FACTORY}`); return; }
    if (q === JETTON_FACTORY || JETTON_FACTORY.startsWith(q) && q.length >= 8) { router.push(`/explorer/factory/${JETTON_FACTORY}`); return; }
    const job = allJobs.find(j => j.address === q || (q.length >= 8 && j.address.startsWith(q)));
    if (job) { router.push(`/explorer/job/${job.address}`); return; }
    setSearchError(true);
  };

  const toggleSort = (col: 'id' | 'status' | 'budget') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All Jobs' }, { key: 'ton', label: 'TON' }, { key: 'usdt', label: 'USDT' },
    { key: 'active', label: 'Active' }, { key: 'completed', label: 'Completed' },
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
            <input type="text" value={search}
              onChange={e => { setSearch(e.target.value); setSearchError(false); }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search by job or factory address..."
              className="flex-1 bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#555] font-mono focus:outline-none focus:border-[#0098EA] transition-colors"
            />
            <button onClick={handleSearch} className="bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-[#888] hover:text-white hover:border-[#0098EA] transition-colors">Search</button>
          </div>
          {searchError && (
            <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">
              Address not found in ENACT Protocol. This explorer tracks only ENACT contracts.
              <div className="mt-1 text-[#555]">Looking for a wallet? Try <a href="https://tonscan.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">tonscan.org</a></div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            <div className="space-y-2">{[1,2,3,4,5].map(i => <Shimmer key={i} className="h-12" />)}</div>
          </div>
        ) : error ? (
          <div className="text-red-400 bg-[#111] border border-[#222] rounded-xl p-6 text-center">Failed to load: {error}</div>
        ) : data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              {[
                { label: 'Total', value: stats.total, icon: null },
                { label: 'TON Jobs', value: stats.ton, icon: <TonIcon size={18} /> },
                { label: 'USDT Jobs', value: stats.usdt, icon: <UsdtIcon size={18} /> },
                { label: 'Completed', value: stats.completed, icon: null },
              ].map(s => (
                <div key={s.label} className="bg-[#111] border border-[#222] rounded-xl p-4">
                  <div className="flex items-center gap-2">
                    {s.icon}
                    <span className="text-[#555] text-xs font-mono uppercase">{s.label}</span>
                  </div>
                  <div className="text-white text-2xl font-semibold mt-1">{s.value}</div>
                </div>
              ))}
            </div>
            <div className="text-[#444] text-xs font-mono mb-6">
              Last updated: <LiveTimer timestamp={data.lastUpdated} /> · Auto-refreshes every 30s
            </div>

            {/* Factories */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              {[
                { label: 'JobFactory', type: 'ton' as const, addr: data.factories.ton.address, count: data.factories.ton.jobCount },
                { label: 'JettonJobFactory', type: 'usdt' as const, addr: data.factories.jetton.address, count: data.factories.jetton.jobCount },
              ].map(f => (
                <Link key={f.label} href={`/explorer/factory/${f.addr}`} className="bg-[#111] border border-[#222] rounded-xl p-4 hover:border-[#333] transition-colors block">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-white font-medium">
                      <TypeIcon type={f.type} size={20} /> {f.label}
                    </span>
                    <span className="text-[#888] text-sm">{f.count} jobs</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-[#555] truncate">{f.addr}</span>
                    <TonscanLink addr={f.addr} />
                    <CopyBtn text={f.addr} />
                  </div>
                </Link>
              ))}
            </div>

            <div className="border-t border-[#222] my-6" />

            {/* Tabs */}
            <div className="flex gap-1 mb-4 overflow-x-auto">
              {tabs.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors whitespace-nowrap ${tab === t.key ? 'bg-[#1a1a1a] text-white border border-[#333]' : 'text-[#888] hover:text-white hover:bg-[#111]'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Jobs Table */}
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a1a] text-[#555] text-xs font-mono uppercase">
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('id')}># {sortBy === 'id' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-4 py-3 hidden sm:table-cell">Address</th>
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('status')}>Status {sortBy === 'status' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-4 py-3 cursor-pointer hover:text-white" onClick={() => toggleSort('budget')}>Budget {sortBy === 'budget' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-4 py-3 hidden md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.length === 0 && <tr><td colSpan={5} className="text-center text-[#555] py-8">No jobs match filter</td></tr>}
                  {filteredJobs.map(job => (
                    <tr key={`${job.type}-${job.jobId}`} onClick={() => router.push(`/explorer/job/${job.address}`)}
                      className="border-b border-[#1a1a1a] cursor-pointer hover:bg-[#151515] transition-colors">
                      <td className="px-4 py-3 text-white font-medium">
                        <span className="inline-flex items-center gap-1.5">#{job.jobId} <TypeIcon type={job.type} size={14} /></span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[#888] hidden sm:table-cell">{truncAddr(job.address)}</td>
                      <td className="px-4 py-3"><Badge status={job.stateName} /></td>
                      <td className="px-4 py-3 text-[#ccc]"><BudgetDisplay job={job} /></td>
                      <td className="px-4 py-3 text-[#555] text-xs hidden md:table-cell">{fmtDateShort(job.createdAt)}</td>
                    </tr>
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

function TonscanLink({ addr }: { addr: string }) {
  return (
    <a href={tonscanUrl(addr)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-[#555] hover:text-[#0098EA] transition-colors" title="View on TONScan">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </a>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={e => { e.stopPropagation(); e.preventDefault(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[#555] hover:text-[#0098EA] transition-colors" title="Copy">
      {copied
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
    </button>
  );
}
