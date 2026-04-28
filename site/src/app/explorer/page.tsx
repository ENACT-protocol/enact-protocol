'use client';

import { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, TonIcon, UsdtIcon, TonscanLink, ClickAddr, AIBadge, FileClip, EncryptedLock,
  BudgetDisplay, truncAddr, fmtDateShort, STATUS_COLORS, EVENT_DOT_COLORS, timeAgo, LiveTimeAgo,
  AgentBadge, useAgenticWallet,
} from './shared';
import { MiniAreaSparkline, MiniBarSparkline, useSparklineData } from './Charts';

type Tab = 'all' | 'ton' | 'usdt' | 'active' | 'completed' | 'disputed' | 'cancelled' | 'transactions';
const PAGE_SIZE = 15;
const ACTIVITY_PAGE = 15;

function useTonPrice() {
  const [price, setPrice] = useState<number>(1.26);
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
        const d = await r.json();
        if (d?.['the-open-network']?.usd) setPrice(d['the-open-network'].usd);
      } catch {
        setPrice(1.26);
      }
    };
    fetchPrice();
    const i = setInterval(fetchPrice, 600_000);
    return () => clearInterval(i);
  }, []);
  return price;
}

function AmountWithIcon({ amount, type }: { amount: string; type: 'ton' | 'usdt' }) {
  if (!amount) return <span>—</span>;
  const replaced = amount.replace(/\b(TON|USDT)\b/g, '___ICON___');
  if (replaced === amount) return <span>{amount}</span>;
  const parts = replaced.split('___ICON___');
  return (
    <span className="inline-flex items-center gap-0.5 flex-wrap">
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <TypeIcon type={type} size={12} />}
        </span>
      ))}
    </span>
  );
}

export default function ExplorerPage() {
  return <Suspense><ExplorerInner /></Suspense>;
}

function ExplorerInner() {
  const { data, loading, error } = useExplorerData();
  const router = useRouter();
  const searchParams = useSearchParams();
  const allJobsForSparkline = useMemo(() => data ? [...data.tonJobs, ...data.jettonJobs] : [], [data]);
  const sparklines = useSparklineData(allJobsForSparkline);
  const tonPrice = useTonPrice();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'id' | 'status' | 'budget'>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [jobPage, setJobPage] = useState(0);
  const [txPage, setTxPage] = useState(0);
  const [actPage, setActPage] = useState(0);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [addrFilter, setAddrFilter] = useState('');

  const allJobs = useMemo(() => data ? [...data.tonJobs, ...data.jettonJobs] : [], [data]);

  // Activity: one fixed snapshot, updated only on page 0
  const activitySnap = useRef<ReturnType<typeof buildActivity>>([]);
  const fresh = buildActivity(allJobs, data?.activity);
  if (fresh.length > 0 && actPage === 0 && txPage === 0) {
    activitySnap.current = fresh;
  } else if (activitySnap.current.length === 0 && fresh.length > 0) {
    activitySnap.current = fresh; // initial load
  }
  const allActivity = activitySnap.current;

  const filteredJobs = useMemo(() => {
    let jobs = allJobs;
    if (tab === 'ton') jobs = jobs.filter(j => j.type === 'ton');
    else if (tab === 'usdt') jobs = jobs.filter(j => j.type === 'usdt');
    else if (tab === 'active') jobs = jobs.filter(j => ['OPEN', 'FUNDED', 'SUBMITTED'].includes(j.stateName));
    else if (tab === 'completed') jobs = jobs.filter(j => j.stateName === 'COMPLETED');
    else if (tab === 'disputed') jobs = jobs.filter(j => j.stateName === 'DISPUTED');
    else if (tab === 'cancelled') jobs = jobs.filter(j => j.stateName === 'CANCELLED');
    if (addrFilter) {
      const f = addrFilter.toLowerCase();
      jobs = jobs.filter(j => String(j.jobId).includes(f) || j.address?.toLowerCase().includes(f) || j.client?.toLowerCase().includes(f) || j.evaluator?.toLowerCase().includes(f) || j.provider?.toLowerCase().includes(f));
    }
    return [...jobs].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'id') cmp = (a.createdAt || 0) - (b.createdAt || 0);
      else if (sortBy === 'status') cmp = a.state - b.state;
      else if (sortBy === 'budget') cmp = Number(BigInt(a.budget) - BigInt(b.budget));
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [allJobs, tab, sortBy, sortDir, addrFilter]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, ton: 0, usdt: 0, tonDone: 0, usdtDone: 0, txTotal: 0 };
    const isDone = (j: Job) => ['COMPLETED', 'DISPUTED', 'CANCELLED'].includes(j.stateName);
    const tonDone = data.tonJobs.filter(isDone).length;
    const usdtDone = data.jettonJobs.filter(isDone).length;
    let txTotal = 0;
    for (const j of allJobs) txTotal += txCount(j);
    return { total: allJobs.length, ton: data.tonJobs.length, usdt: data.jettonJobs.length, tonDone, usdtDone, txTotal };
  }, [data, allJobs]);

  const volumeStats = useMemo(() => {
    if (!data) return { tonVol: '0', usdtVol: '0', tonNum: 0, usdtNum: 0 };
    const tonTotal = data.tonJobs.reduce((s, j) => s + BigInt(j.budget), BigInt(0));
    const usdtTotal = data.jettonJobs.reduce((s, j) => s + BigInt(j.budget), BigInt(0));
    return { tonVol: (Number(tonTotal) / 1e9).toFixed(1), usdtVol: (Number(usdtTotal) / 1e6).toFixed(2), tonNum: Number(tonTotal) / 1e9, usdtNum: Number(usdtTotal) / 1e6 };
  }, [data]);

  const agentStats = useMemo(() => {
    if (!allJobs.length) return { total: 0, clients: 0, evaluators: 0, providers: 0 };
    const clients = new Set<string>(), evaluators = new Set<string>(), providers = new Set<string>(), all = new Set<string>();
    for (const j of allJobs) {
      if (j.client) { clients.add(j.client); all.add(j.client); }
      if (j.evaluator) { evaluators.add(j.evaluator); all.add(j.evaluator); }
      if (j.provider && j.provider !== 'none') { providers.add(j.provider); all.add(j.provider); }
    }
    return { total: all.size, clients: clients.size, evaluators: evaluators.size, providers: providers.size };
  }, [allJobs]);

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

  // Handle search from header
  useEffect(() => {
    const q = searchParams?.get('q');
    if (q && data) {
      setSearch(q);
      // Trigger search
      const query = q.trim();
      if (query === FACTORY || (query.length >= 8 && FACTORY.startsWith(query))) { router.push(`/explorer/factory/${FACTORY}`); return; }
      if (query === JETTON_FACTORY || (query.length >= 8 && JETTON_FACTORY.startsWith(query))) { router.push(`/explorer/factory/${JETTON_FACTORY}`); return; }
      const job = allJobs.find(j => j.address === query || (query.length >= 8 && j.address.startsWith(query)));
      if (job) { router.push(`/explorer/job/${job.address}`); return; }
    }
  }, [searchParams, data]);

  const toggleSort = (col: 'id' | 'status' | 'budget') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
    setJobPage(0);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All Jobs' }, { key: 'ton', label: 'TON' }, { key: 'usdt', label: 'USDT' },
    { key: 'active', label: 'Active' }, { key: 'completed', label: 'Completed' },
    { key: 'disputed', label: 'Disputed' }, { key: 'cancelled', label: 'Cancelled' },
  ];

  const jobsOnPage = filteredJobs.slice(jobPage * PAGE_SIZE, (jobPage + 1) * PAGE_SIZE);
  const totalJobPages = Math.ceil(filteredJobs.length / PAGE_SIZE) || 1;
  const txOnPage = allActivity.slice(txPage * PAGE_SIZE, (txPage + 1) * PAGE_SIZE);
  const totalTxPages = Math.ceil(allActivity.length / PAGE_SIZE) || 1;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <h1 className="font-serif text-3xl sm:text-4xl text-white mb-2 explorer-title">Explorer</h1>
        <p className="text-[#636370] text-sm mb-8">Browse ENACT Protocol jobs and factories on TON Mainnet</p>

        {loading ? (
          <div className="space-y-4"><div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Shimmer key={i} className="h-20 rounded-xl" />)}</div><Shimmer className="h-48 rounded-xl" /></div>
        ) : error ? (
          <div className="text-red-400 bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-6 text-center">Failed to load: {error}</div>
        ) : data && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 explorer-stats" style={{ overflow: 'visible' }}>
              <StatCard label="Total Jobs" value={stats.total}
                sub={<><span>{stats.ton}</span> <TonIcon size={10} /> <span className="text-[#3F3F46] mx-0.5">·</span> <span>{stats.usdt}</span> <UsdtIcon size={10} /></>}
                sparkline={sparklines.cumJobsTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumJobsTotal} color="#0088CC" meta={{ label: 'jobs', days: sparklines.days, details: [{ label: 'TON', data: sparklines.cumJobsTon }, { label: 'USDT', data: sparklines.cumJobsUsdt }] }} /> : undefined} />
              <StatCard label="Agents" value={agentStats.total}
                sub={<span>{agentStats.clients} clients · {agentStats.evaluators} evaluators · {agentStats.providers} providers</span>}
                sparkline={sparklines.cumAgentsTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumAgentsTotal} color="#B8860B" meta={{ label: 'agents', days: sparklines.days, details: [{ label: 'Clients', data: sparklines.cumAgentsClients }, { label: 'Evaluators', data: sparklines.cumAgentsEvaluators }, { label: 'Providers', data: sparklines.cumAgentsProviders }] }} /> : undefined} />
              <StatCard label="Total Volume" value={`$${(volumeStats.tonNum * tonPrice + volumeStats.usdtNum).toFixed(0)}`}
                sub={<><span>{volumeStats.tonVol}</span> <TonIcon size={10} /> <span className="text-[#3F3F46] mx-0.5">·</span> <span>{volumeStats.usdtVol}</span> <UsdtIcon size={10} /></>}
                sparkline={sparklines.cumVolumeTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumVolumeTotal.map((v, i) => sparklines.cumVolumeTon[i] * tonPrice + sparklines.cumVolumeUsdt[i])} color="#26A17B" meta={{ label: '$', days: sparklines.days, details: [{ label: 'TON', data: sparklines.cumVolumeTon }, { label: 'USDT', data: sparklines.cumVolumeUsdt }] }} /> : undefined} />
              <StatCard label="Transactions" value={stats.txTotal}
                sub={<span>across {stats.total} jobs</span>}
                sparkline={sparklines.txnsPerDay.length > 1 ? <MiniBarSparkline data={sparklines.txnsPerDay} color="#4A90D9" meta={{ label: 'txns', days: sparklines.txDays }} /> : undefined} />
            </div>

            {/* Latest Activity */}
            <div className="mb-6">
              <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.03)]">
                  <span className="text-white text-sm font-semibold">Latest Activity</span>
                  <InlinePageNav page={actPage} total={Math.ceil(allActivity.length / ACTIVITY_PAGE) || 1} onChange={setActPage} />
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm explorer-table">
                  <thead><tr className="border-b border-[rgba(255,255,255,0.03)] text-[#52525B] text-[10px] uppercase tracking-[0.06em] font-medium">
                    <th className="text-left px-5 py-2">Job</th>
                    <th className="text-left px-3 py-2">Event</th>
                    <th className="text-left px-3 py-2 hidden xl:table-cell">Tx Address</th>
                    <th className="text-left px-3 py-2 hidden lg:table-cell">Status</th>
                    <th className="text-left px-3 py-2 hidden md:table-cell">From</th>
                    <th className="text-left px-3 py-2 hidden sm:table-cell">Amount</th>
                    <th className="text-right px-5 py-2">Time</th>
                  </tr></thead>
                  <tbody>
                    {allActivity.slice(actPage * ACTIVITY_PAGE, (actPage + 1) * ACTIVITY_PAGE).map((ev, i) => (
                      <tr key={`act-${ev.address}-${ev.event}-${ev.time}`} onClick={() => router.push(`/explorer/job/${ev.address}`)}
                        className="border-b border-[rgba(255,255,255,0.03)] last:border-0 cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors explorer-row">
                        <td className="px-5 py-2 whitespace-nowrap"><span className="text-white">#{ev.jobId}</span> <TypeIcon type={ev.type} size={14} /></td>
                        <td className="px-3 py-2 whitespace-nowrap"><span style={{ color: ev.txStatus === 'pending' ? '#F59E0B' : ev.txStatus === 'confirmed' ? '#3B82F6' : (EVENT_DOT_COLORS[ev.event] || STATUS_COLORS[ev.status] || '#555') }} className={`mr-2${ev.txStatus === 'pending' ? ' animate-pulse' : ''}`}>●</span> {ev.event}{ev.txStatus === 'confirmed' ? ' ✓' : ''}</td>
                        <td className="px-3 py-2 hidden xl:table-cell">{ev.txHash ? <a href={`https://tonscan.org/tx/${ev.txHash}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="font-mono text-xs text-[#A1A1AA] hover:text-white cursor-pointer">{truncAddr(ev.txHash)}</a> : <span className="text-[#52525B]">—</span>}</td>
                        <td className="px-3 py-2 hidden lg:table-cell"><Badge status={ev.status} /></td>
                        <td className="px-3 py-2 hidden md:table-cell">{ev.from ? <ClickAddr addr={ev.from} truncate /> : '—'}</td>
                        <td className="px-3 py-2 text-white hidden sm:table-cell whitespace-nowrap">{ev.amount ? <AmountWithIcon amount={ev.amount} type={ev.type} /> : '—'}</td>
                        <td className="px-5 py-2 text-[#636370] text-xs whitespace-nowrap text-right"><LiveTimeAgo ts={ev.time} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </div>

            {/* Factories */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              {[{ label: 'JobFactory', type: 'ton' as const, addr: data.factories.ton.address, count: data.factories.ton.jobCount },
                { label: 'JettonJobFactory', type: 'usdt' as const, addr: data.factories.jetton.address, count: data.factories.jetton.jobCount }].map(f => (
                <Link key={f.label} href={`/explorer/factory/${f.addr}`} className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl px-5 py-4 hover:border-[rgba(255,255,255,0.1)] transition-colors block cursor-pointer explorer-factory">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <TypeIcon type={f.type} size={28} />
                      <div>
                        <span className="text-white font-medium text-sm">{f.label}</span>
                        <div className="flex items-center gap-1 mt-0.5"><span className="font-mono text-xs text-[#A1A1AA]">{truncAddr(f.addr)}</span></div>
                      </div>
                    </div>
                    <span className="text-white text-sm font-medium">{f.count} jobs</span>
                  </div>
                </Link>
              ))}
            </div>

            {/* Jobs */}
            <div className="mb-6">
              <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden">
                {/* Jobs header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.03)] gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-white text-sm font-semibold">Jobs</span>
                    {/* Desktop: tab pills */}
                    <div className="hidden sm:flex gap-0.5 bg-[rgba(255,255,255,0.05)] rounded-lg p-0.5">
                      {tabs.map(t => (
                        <button key={t.key} onClick={() => { setTab(t.key); setJobPage(0); setTxPage(0); }}
                          className={`px-3 py-1 text-xs rounded-md transition-colors whitespace-nowrap cursor-pointer font-medium ${tab === t.key ? 'bg-[rgba(0,152,234,0.1)] text-[#0098EA]' : 'text-[#71717A] hover:text-[#A1A1AA]'}`}>
                          {t.label === 'All Jobs' ? 'All' : t.label === 'Completed' ? 'Completed' : t.label}
                        </button>
                      ))}
                    </div>
                    {/* Mobile: dropdown filter button */}
                    <div className="relative sm:hidden">
                      <button onClick={() => setMobileFilterOpen(!mobileFilterOpen)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-[rgba(255,255,255,0.05)] text-[#A1A1AA] cursor-pointer">
                        {tabs.find(t => t.key === tab)?.label === 'All Jobs' ? 'All' : tabs.find(t => t.key === tab)?.label === 'Completed' ? 'Done' : tabs.find(t => t.key === tab)?.label}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
                      </button>
                      {mobileFilterOpen && (
                        <div className="absolute top-full left-0 mt-1 w-[120px] rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0A0A0F] p-1 shadow-xl z-50">
                          {tabs.map(t => (
                            <button key={t.key} onClick={() => { setTab(t.key); setJobPage(0); setMobileFilterOpen(false); }}
                              className={`w-full text-left px-3 py-1.5 text-xs rounded-md cursor-pointer ${tab === t.key ? 'text-[#0098EA]' : 'text-[#A1A1AA] hover:text-white hover:bg-[rgba(255,255,255,0.03)]'}`}>
                              {t.label === 'All Jobs' ? 'All' : t.label === 'Completed' ? 'Completed' : t.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <InlinePageNav page={jobPage} total={totalJobPages} onChange={setJobPage} />
                    <input type="text" value={addrFilter} onChange={e => { setAddrFilter(e.target.value); setJobPage(0); }}
                      placeholder="Filter by address or job ID..."
                      className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded px-3 py-1.5 text-xs text-white placeholder-[#52525B] font-mono focus:outline-none focus:border-[#0098EA] transition-colors w-56 hidden sm:block" />
                  </div>
                </div>

                <div className="overflow-x-auto">
                <table className="w-full text-sm explorer-table">
                  <thead><tr className="border-b border-[rgba(255,255,255,0.03)] text-[#52525B] text-[10px] uppercase tracking-[0.06em] font-medium">
                    <th className="text-left px-5 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('id')}># {sortBy === 'id' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-3 py-2.5 hidden sm:table-cell">Address</th>
                    <th className="text-left px-3 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('status')}>Status {sortBy === 'status' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-3 py-2.5 hidden md:table-cell">Client</th>
                    <th className="text-left px-3 py-2.5 hidden lg:table-cell">Evaluator</th>
                    <th className="text-left px-3 py-2.5 cursor-pointer hover:text-white" onClick={() => toggleSort('budget')}>Budget {sortBy === 'budget' && (sortDir === 'desc' ? '↓' : '↑')}</th>
                    <th className="text-left px-3 py-2.5 hidden md:table-cell">Txns</th>
                    <th className="text-right px-5 py-2.5 hidden md:table-cell">Created</th>
                  </tr></thead>
                  <tbody>
                    {jobsOnPage.length === 0 && <tr><td colSpan={8} className="text-center text-[#52525B] py-8">No jobs match filter</td></tr>}
                    {jobsOnPage.map(job => (
                      <tr key={`${job.type}-${job.jobId}`} onClick={() => router.push(`/explorer/job/${job.address}`)}
                        className="border-b border-[rgba(255,255,255,0.03)] cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors">
                        <td className="px-5 py-2.5 text-white"><span className="inline-flex items-center gap-1.5 font-medium">#{job.jobId} <TypeIcon type={job.type} size={14} />{job.hasFile && <FileClip />}{job.resultContent?.encrypted && <EncryptedLock />}</span></td>
                        <td className="px-3 py-2.5 hidden sm:table-cell [&_.break-all]:text-white" onClick={e => e.stopPropagation()}><ClickAddr addr={job.address} truncate /></td>
                        <td className="px-3 py-2.5"><Badge status={job.stateName} pending={job.pendingState} /></td>
                        <td className="px-3 py-2.5 hidden md:table-cell"><ClickAddr addr={job.client} truncate /></td>
                        <td className="px-3 py-2.5 hidden lg:table-cell">{job.evaluator === AI_EVALUATOR ? <span className="inline-flex items-center gap-1.5 text-[#A1A1AA] text-xs font-mono">AI Evaluator <TonscanLink addr={AI_EVALUATOR} /></span> : <ClickAddr addr={job.evaluator} truncate />}</td>
                        <td className="px-3 py-2.5 text-white"><BudgetDisplay job={job} /></td>
                        <td className="px-3 py-2.5 hidden md:table-cell text-[#52525B] text-xs">{txCount(job)}</td>
                        <td className="px-5 py-2.5 text-[#636370] text-xs hidden md:table-cell whitespace-nowrap text-right">{fmtDateShort(job.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function StatCard({ label, value, sub, sparkline }: { label: string; value: string | number; sub?: React.ReactNode; sparkline?: React.ReactNode }) {
  return (
    <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl relative" style={{ minHeight: sparkline ? 145 : undefined }}>
      <div className="px-3 sm:px-5 pt-3 sm:pt-4 pb-1 sm:pb-2 relative z-10">
        <div className="text-[#636370] text-[9px] sm:text-[10px] font-mono uppercase tracking-wider mb-0.5 sm:mb-1">{label}</div>
        <div className="flex items-baseline gap-1 sm:gap-2 flex-wrap">
          <span className="text-[#F4F4F5] text-xl sm:text-[28px] font-semibold tracking-tight">{value}</span>
          {sub && <span className="inline-flex items-center gap-0.5 sm:gap-1 text-[10px] sm:text-[11px] text-[#636370]">{sub}</span>}
        </div>
      </div>
      {sparkline && (
        <div className="absolute bottom-0 left-0 right-0 h-[55px]" style={{ overflow: 'visible' }}>
          {sparkline}
        </div>
      )}
    </div>
  );
}

function InlinePageNav({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  return (
    <nav className="flex items-center gap-2" aria-label="Pagination">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} aria-label="Previous page" className="w-7 h-6 flex items-center justify-center text-xs rounded-md bg-[rgba(255,255,255,0.03)] text-[#71717A] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&larr;</button>
      <span className="text-[#A1A1AA] text-xs whitespace-nowrap" aria-live="polite">{page + 1} / {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1} aria-label="Next page" className="w-7 h-6 flex items-center justify-center text-xs rounded-md bg-[rgba(255,255,255,0.03)] text-[#A1A1AA] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&rarr;</button>
    </nav>
  );
}

function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-2 mt-4" aria-label="Pagination">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} aria-label="Previous page" className="px-3 py-1.5 text-sm rounded border border-[rgba(255,255,255,0.06)] text-[#A1A1AA] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&larr;</button>
      <span className="text-[#52525B] text-sm" aria-live="polite">{page + 1} / {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1} aria-label="Next page" className="px-3 py-1.5 text-sm rounded border border-[rgba(255,255,255,0.06)] text-[#A1A1AA] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&rarr;</button>
    </nav>
  );
}
