'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import {
  FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity,
  Badge, Shimmer, TypeIcon, TonIcon, UsdtIcon,
  AddrWithActions, LiveTimer, BudgetDisplay, TonscanLink, CopyButton,
  truncAddr, fmtDateShort, tonscanUrl, timeAgo, STATUS_DOTS,
} from './shared';

type Tab = 'all' | 'ton' | 'usdt' | 'active' | 'completed';

export default function ExplorerPage() {
  const { data, loading, error } = useExplorerData();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
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
    if (!data) return { total: 0, ton: 0, usdt: 0, tonDone: 0, usdtDone: 0, txCount: 0 };
    const tonDone = data.tonJobs.filter(j => j.stateName === 'COMPLETED').length;
    const usdtDone = data.jettonJobs.filter(j => j.stateName === 'COMPLETED').length;
    // Estimate transactions: each job has at least create+fund, submitted adds 1, completed adds 1
    let txCount = 0;
    for (const j of allJobs) {
      txCount += 1; // create
      if (j.state >= 1) txCount += 1; // fund
      if (j.submittedAt) txCount += 1; // submit (includes take)
      if (j.stateName === 'COMPLETED' || j.stateName === 'DISPUTED') txCount += 1; // evaluate
      if (j.stateName === 'CANCELLED') txCount += 1; // cancel
    }
    return { total: allJobs.length, ton: data.tonJobs.length, usdt: data.jettonJobs.length, tonDone, usdtDone, txCount };
  }, [data, allJobs]);

  const activity = useMemo(() => buildActivity(allJobs).slice(0, 12), [allJobs]);

  const handleSearch = () => {
    if (!search.trim() || !data) return;
    const q = search.trim();
    setSearchMsg(null);
    if (q === FACTORY || (q.length >= 8 && FACTORY.startsWith(q))) { router.push(`/explorer/factory/${FACTORY}`); return; }
    if (q === JETTON_FACTORY || (q.length >= 8 && JETTON_FACTORY.startsWith(q))) { router.push(`/explorer/factory/${JETTON_FACTORY}`); return; }
    const job = allJobs.find(j => j.address === q || (q.length >= 8 && j.address.startsWith(q)));
    if (job) { router.push(`/explorer/job/${job.address}`); return; }
    if (/^[0-9a-fA-F]{64}$/.test(q)) {
      setSearchMsg('tx_hash');
    } else {
      setSearchMsg('not_found');
    }
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
              onChange={e => { setSearch(e.target.value); setSearchMsg(null); }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search by job or factory address..."
              className="flex-1 bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#555] font-mono focus:outline-none focus:border-[#0098EA] transition-colors"
            />
            <button onClick={handleSearch} className="bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-[#888] hover:text-white hover:border-[#0098EA] transition-colors">Search</button>
          </div>
          {searchMsg === 'not_found' && (
            <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">
              Address not found in ENACT Protocol. This explorer tracks only ENACT contracts.
              <div className="mt-1 text-[#555]">Looking for a wallet? Try <a href="https://tonscan.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">tonscan.org</a></div>
            </div>
          )}
          {searchMsg === 'tx_hash' && (
            <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">
              Transaction hash search is not supported. <a href="https://tonscan.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">Use tonscan.org to search by transaction hash.</a>
            </div>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            <Shimmer className="h-48 rounded-xl" />
            <div className="space-y-2">{[1,2,3,4,5].map(i => <Shimmer key={i} className="h-12" />)}</div>
          </div>
        ) : error ? (
          <div className="text-red-400 bg-[#111] border border-[#222] rounded-xl p-6 text-center">Failed to load: {error}</div>
        ) : data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              <StatCard label="Transactions" value={stats.txCount} />
              <StatCard label="TON Jobs" value={`${stats.ton}`} sub={`${stats.tonDone} done`} icon={<TonIcon size={18} />} />
              <StatCard label="USDT Jobs" value={`${stats.usdt}`} sub={`${stats.usdtDone} done`} icon={<UsdtIcon size={18} />} />
              <StatCard label="Total Jobs" value={stats.total} />
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
                    <span className="flex items-center gap-2 text-white font-medium"><TypeIcon type={f.type} size={20} /> {f.label}</span>
                    <span className="text-[#888] text-sm">{f.count} jobs</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-[#555] truncate">{f.addr}</span>
                    <TonscanLink addr={f.addr} />
                    <CopyButton text={f.addr} />
                  </div>
                </Link>
              ))}
            </div>

            {/* Latest Activity */}
            {activity.length > 0 && (
              <>
                <div className="border-t border-[#222] my-6" />
                <div className="mb-6">
                  <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Latest Activity</div>
                  <div className="bg-[#111] border border-[#222] rounded-xl overflow-hidden">
                    {activity.map((ev, i) => (
                      <div key={`${ev.address}-${ev.event}-${i}`}
                        onClick={() => router.push(`/explorer/job/${ev.address}`)}
                        className="flex items-center gap-3 px-4 py-2.5 border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors text-sm">
                        <span className={`${STATUS_DOTS[ev.status]} text-lg leading-none`}>●</span>
                        <span className="text-white whitespace-nowrap">Job #{ev.jobId}</span>
                        <TypeIcon type={ev.type} size={14} />
                        <span className="text-[#888]">{ev.event}</span>
                        {ev.budget && <span className="text-[#555] hidden sm:inline">{ev.budget}</span>}
                        <span className="ml-auto text-[#555] text-xs whitespace-nowrap">{timeAgo(ev.time)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

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

function StatCard({ label, value, sub, icon }: { label: string; value: string | number; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[#555] text-xs font-mono uppercase">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-white text-2xl font-semibold">{value}</span>
        {sub && <span className="text-[#555] text-xs">({sub})</span>}
      </div>
    </div>
  );
}
