'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, TonIcon, UsdtIcon, TonscanLink, ClickAddr, AIBadge,
  BudgetDisplay, truncAddr, fmtDateShort, STATUS_COLORS, timeAgo,
} from './shared';

type Tab = 'all' | 'ton' | 'usdt' | 'active' | 'completed' | 'transactions';
const PAGE_SIZE = 20;
const ACTIVITY_PAGE = 15;

export default function ExplorerPage() {
  const { data, loading, error } = useExplorerData();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'id' | 'status' | 'budget'>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [jobPage, setJobPage] = useState(0);
  const [txPage, setTxPage] = useState(0);
  const [actPage, setActPage] = useState(0);

  const allJobs = useMemo(() => data ? [...data.tonJobs, ...data.jettonJobs] : [], [data]);
  const allActivity = useMemo(() => buildActivity(allJobs), [allJobs]);

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
    if (!data) return { total: 0, ton: 0, usdt: 0, tonDone: 0, usdtDone: 0, txTotal: 0 };
    const isDone = (j: Job) => ['COMPLETED', 'DISPUTED', 'CANCELLED'].includes(j.stateName);
    const tonDone = data.tonJobs.filter(isDone).length;
    const usdtDone = data.jettonJobs.filter(isDone).length;
    let txTotal = 0;
    for (const j of allJobs) txTotal += txCount(j);
    return { total: allJobs.length, ton: data.tonJobs.length, usdt: data.jettonJobs.length, tonDone, usdtDone, txTotal };
  }, [data, allJobs]);

  const handleSearch = () => {
    if (!search.trim() || !data) return;
    const q = search.trim();
    setSearchMsg(null);
    if (q === FACTORY || (q.length >= 8 && FACTORY.startsWith(q))) { router.push(`/explorer/factory/${FACTORY}`); return; }
    if (q === JETTON_FACTORY || (q.length >= 8 && JETTON_FACTORY.startsWith(q))) { router.push(`/explorer/factory/${JETTON_FACTORY}`); return; }
    const job = allJobs.find(j => j.address === q || (q.length >= 8 && j.address.startsWith(q)));
    if (job) { router.push(`/explorer/job/${job.address}`); return; }
    setSearchMsg(/^[0-9a-fA-F]{64}$/.test(q) ? 'tx_hash' : 'not_found');
  };

  const toggleSort = (col: 'id' | 'status' | 'budget') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
    setJobPage(0);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All Jobs' }, { key: 'ton', label: 'TON' }, { key: 'usdt', label: 'USDT' },
    { key: 'active', label: 'Active' }, { key: 'completed', label: 'Completed' }, { key: 'transactions', label: 'All Transactions' },
  ];

  const jobsOnPage = filteredJobs.slice(jobPage * PAGE_SIZE, (jobPage + 1) * PAGE_SIZE);
  const totalJobPages = Math.ceil(filteredJobs.length / PAGE_SIZE) || 1;
  const txOnPage = allActivity.slice(txPage * PAGE_SIZE, (txPage + 1) * PAGE_SIZE);
  const totalTxPages = Math.ceil(allActivity.length / PAGE_SIZE) || 1;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <h1 className="font-serif text-3xl sm:text-4xl text-white mb-2">Explorer</h1>
        <p className="text-[#888] text-sm mb-8">Browse ENACT Protocol jobs and factories on TON Mainnet</p>

        {/* Search */}
        <div className="mb-8">
          <div className="flex gap-2">
            <input type="text" value={search} onChange={e => { setSearch(e.target.value); setSearchMsg(null); }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Search by job or factory address..."
              aria-label="Search by job or factory address"
              className="flex-1 bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#555] font-mono focus:outline-none focus:border-[#0098EA] transition-colors" />
            <button onClick={handleSearch} className="bg-[#111] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-[#888] hover:text-white hover:border-[#0098EA] transition-colors cursor-pointer">Search</button>
          </div>
          {searchMsg === 'not_found' && <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">Address not found in ENACT Protocol. <a href="https://tonscan.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">Try tonscan.org</a></div>}
          {searchMsg === 'tx_hash' && <div className="mt-3 text-sm text-[#888] bg-[#111] border border-[#222] rounded-lg p-4">Transaction hash search is not supported. <a href="https://tonscan.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0098EA]">Use tonscan.org</a></div>}
        </div>

        {loading ? (
          <div className="space-y-4"><div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Shimmer key={i} className="h-20 rounded-xl" />)}</div><Shimmer className="h-48 rounded-xl" /></div>
        ) : error ? (
          <div className="text-red-400 bg-[#111] border border-[#222] rounded-xl p-6 text-center">Failed to load: {error}</div>
        ) : data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              <StatCard label="Transactions" value={stats.txTotal} />
              <StatCard label="TON Jobs" value={stats.ton} sub={stats.tonDone ? `${stats.tonDone} done` : undefined} icon={<TonIcon size={18} />} />
              <StatCard label="USDT Jobs" value={stats.usdt} sub={stats.usdtDone ? `${stats.usdtDone} done` : undefined} icon={<UsdtIcon size={18} />} />
              <StatCard label="Total Jobs" value={stats.total} />
            </div>

            {/* Factories */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              {[{ label: 'JobFactory', type: 'ton' as const, addr: data.factories.ton.address, count: data.factories.ton.jobCount },
                { label: 'JettonJobFactory', type: 'usdt' as const, addr: data.factories.jetton.address, count: data.factories.jetton.jobCount }].map(f => (
                <Link key={f.label} href={`/explorer/factory/${f.addr}`} className="bg-[#111] border border-[#222] rounded-xl p-4 hover:border-[#333] transition-colors block cursor-pointer">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-white font-medium"><TypeIcon type={f.type} size={20} /> {f.label}</span>
                    <span className="text-[#888] text-sm">{f.count} jobs</span>
                  </div>
                  <div className="flex items-center gap-1.5"><ClickAddr addr={f.addr} truncate /></div>
                </Link>
              ))}
            </div>

            {/* Latest Activity */}
            <div className="border-t border-[#222] my-6" />
            <div className="mb-6">
              <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Latest Activity</div>
              <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-[11px] font-mono uppercase tracking-[1px] font-medium">
                    <th className="text-left px-3 py-2">Job</th>
                    <th className="text-left px-3 py-2">Event</th>
                    <th className="text-left px-3 py-2 hidden xl:table-cell">Tx Address</th>
                    <th className="text-left px-3 py-2 hidden lg:table-cell">Status</th>
                    <th className="text-left px-3 py-2 hidden md:table-cell">From</th>
                    <th className="text-left px-3 py-2 hidden sm:table-cell">Amount</th>
                    <th className="text-left px-3 py-2">Time</th>
                  </tr></thead>
                  <tbody>
                    {allActivity.slice(actPage * ACTIVITY_PAGE, (actPage + 1) * ACTIVITY_PAGE).map((ev, i) => (
                      <tr key={`act-${ev.address}-${ev.event}-${ev.time}`} onClick={() => router.push(`/explorer/job/${ev.address}`)}
                        className="border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors explorer-row">
                        <td className="px-3 py-2 whitespace-nowrap"><span className="text-white">#{ev.jobId}</span> <TypeIcon type={ev.type} size={14} /></td>
                        <td className="px-3 py-2 whitespace-nowrap"><span style={{ color: STATUS_COLORS[ev.status] }} className="mr-1.5">●</span>{ev.event}</td>
                        <td className="px-3 py-2 hidden xl:table-cell">{ev.txHash ? <a href={`https://tonscan.org/tx/${ev.txHash}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="font-mono text-xs text-[#888] hover:text-white cursor-pointer">{truncAddr(ev.txHash)}</a> : <span className="text-[#555]">—</span>}</td>
                        <td className="px-3 py-2 hidden lg:table-cell"><Badge status={ev.status} /></td>
                        <td className="px-3 py-2 hidden md:table-cell">{ev.from ? <ClickAddr addr={ev.from} truncate /> : '—'}</td>
                        <td className="px-3 py-2 text-[#ccc] hidden sm:table-cell whitespace-nowrap">{ev.amount}</td>
                        <td className="px-3 py-2 text-[#555] text-xs whitespace-nowrap">{timeAgo(ev.time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={actPage} total={Math.ceil(allActivity.length / ACTIVITY_PAGE) || 1} onChange={setActPage} />
            </div>

            <div className="border-t border-[#222] my-6" />

            {/* Tabs */}
            <div className="flex gap-1 mb-4 overflow-x-auto">
              {tabs.map(t => (
                <button key={t.key} onClick={() => { setTab(t.key); setJobPage(0); setTxPage(0); }}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors whitespace-nowrap cursor-pointer ${tab === t.key ? 'bg-[#1a1a1a] text-white border border-[#333]' : 'text-[#888] hover:text-white hover:bg-[#111]'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'transactions' ? (
              <>
                <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-[11px] font-mono uppercase tracking-[1px] font-medium">
                      <th className="text-left px-3 py-2.5">Event</th><th className="text-left px-3 py-2.5">Job</th>
                      <th className="text-left px-3 py-2.5 hidden md:table-cell">From</th>
                      <th className="text-left px-3 py-2.5 hidden sm:table-cell">Amount</th>
                      <th className="text-left px-3 py-2.5">Time</th>
                    </tr></thead>
                    <tbody>
                      {txOnPage.map((ev, i) => (
                        <tr key={`tx-${txPage}-${i}`} onClick={() => router.push(`/explorer/job/${ev.address}`)}
                          className="border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors">
                          <td className="px-3 py-2 whitespace-nowrap"><span style={{ color: STATUS_COLORS[ev.status] }} className="mr-1.5">●</span>{ev.event}</td>
                          <td className="px-3 py-2 whitespace-nowrap"><span className="text-white">#{ev.jobId}</span> <TypeIcon type={ev.type} size={14} /></td>
                          <td className="px-3 py-2 hidden md:table-cell">{ev.from ? <ClickAddr addr={ev.from} truncate /> : '—'}</td>
                          <td className="px-3 py-2 text-[#ccc] hidden sm:table-cell whitespace-nowrap">{ev.amount}</td>
                          <td className="px-3 py-2 text-[#555] text-xs whitespace-nowrap">{timeAgo(ev.time)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={txPage} total={totalTxPages} onChange={setTxPage} />
              </>
            ) : (
              <>
                <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-[11px] font-mono uppercase tracking-[1px] font-medium">
                      <th className="text-left px-3 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('id')}># {sortBy === 'id' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                      <th className="text-left px-3 py-2.5 hidden sm:table-cell">Address</th>
                      <th className="text-left px-3 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('status')}>Status {sortBy === 'status' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                      <th className="text-left px-3 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('budget')}>Budget {sortBy === 'budget' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                      <th className="text-left px-3 py-2.5 hidden md:table-cell">Client</th>
                      <th className="text-left px-3 py-2.5 hidden lg:table-cell">Evaluator</th>
                      <th className="text-left px-3 py-2.5 hidden md:table-cell">Txns</th>
                      <th className="text-left px-3 py-2.5 hidden md:table-cell">Created</th>
                    </tr></thead>
                    <tbody>
                      {jobsOnPage.length === 0 && <tr><td colSpan={8} className="text-center text-[#555] py-8">No jobs match filter</td></tr>}
                      {jobsOnPage.map(job => (
                        <tr key={`${job.type}-${job.jobId}`} onClick={() => router.push(`/explorer/job/${job.address}`)}
                          className="border-b border-[#1a1a1a] cursor-pointer hover:bg-[#151515] transition-colors">
                          <td className="px-3 py-2.5 text-white"><span className="inline-flex items-center gap-1.5 font-medium">#{job.jobId} <TypeIcon type={job.type} size={14} /></span></td>
                          <td className="px-3 py-2.5 hidden sm:table-cell"><span className="inline-flex items-center gap-1.5"><span className="font-mono text-xs text-[#888]">{truncAddr(job.address)}</span><TonscanLink addr={job.address} size={12} /></span></td>
                          <td className="px-3 py-2.5"><Badge status={job.stateName} /></td>
                          <td className="px-3 py-2.5 text-[#ccc]"><BudgetDisplay job={job} /></td>
                          <td className="px-3 py-2.5 hidden md:table-cell"><ClickAddr addr={job.client} truncate /></td>
                          <td className="px-3 py-2.5 hidden lg:table-cell">{job.evaluator === AI_EVALUATOR ? <AIBadge addr={AI_EVALUATOR} /> : <ClickAddr addr={job.evaluator} truncate />}</td>
                          <td className="px-3 py-2.5 hidden md:table-cell text-[#555] text-xs">{txCount(job)}</td>
                          <td className="px-3 py-2.5 text-[#555] text-xs hidden md:table-cell whitespace-nowrap">{fmtDateShort(job.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={jobPage} total={totalJobPages} onChange={setJobPage} />
              </>
            )}
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
      <div className="flex items-center gap-2">{icon}<span className="text-[#555] text-xs font-mono uppercase">{label}</span></div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-white text-2xl font-semibold">{value}</span>
        {sub && <span className="text-[#555] text-xs">({sub})</span>}
      </div>
    </div>
  );
}

function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-2 mt-4" aria-label="Pagination">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} aria-label="Previous page" className="px-3 py-1.5 text-sm rounded border border-[#222] text-[#888] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&larr;</button>
      <span className="text-[#555] text-sm" aria-live="polite">{page + 1} / {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1} aria-label="Next page" className="px-3 py-1.5 text-sm rounded border border-[#222] text-[#888] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&rarr;</button>
    </nav>
  );
}
