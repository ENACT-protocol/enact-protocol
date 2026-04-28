'use client';

import { useState, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, ClickAddr, TonscanLink,
  BudgetDisplay, truncAddr, fmtDateShort, timeAgo, LiveTimeAgo, STATUS_COLORS, EVENT_DOT_COLORS, AIBadge, FileClip, EncryptedLock,
  AgentBadge,
} from '../../shared';
import { MiniAreaSparkline, useSparklineData } from '../../Charts';

type Tab = 'all' | 'active' | 'completed' | 'disputed' | 'cancelled';
const PAGE_SIZE = 15;
const ACTIVITY_PAGE = 15;

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

export default function FactoryPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const router = useRouter();
  const [actPage, setActPage] = useState(0);
  const [jobPage, setJobPage] = useState(0);
  const [tab, setTab] = useState<Tab>('all');
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'id' | 'status' | 'budget'>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [addrFilter, setAddrFilter] = useState('');

  const info = useMemo(() => {
    if (!data) return null;
    if (address === FACTORY) return { label: 'JobFactory', type: 'ton' as const, ...data.factories.ton, jobs: data.tonJobs };
    if (address === JETTON_FACTORY) return { label: 'JettonJobFactory', type: 'usdt' as const, ...data.factories.jetton, jobs: data.jettonJobs };
    return null;
  }, [data, address]);

  const sparklines = useSparklineData(info?.jobs, info?.type);

  const stats = useMemo(() => {
    if (!info) return { total: 0, done: 0, open: 0, completed: 0, disputed: 0, cancelled: 0, volume: '0', volumeNum: 0 };
    const c = (s: string) => info.jobs.filter(j => j.stateName === s).length;
    const isDone = (j: Job) => ['COMPLETED', 'DISPUTED', 'CANCELLED'].includes(j.stateName);
    const done = info.jobs.filter(isDone).length;
    const open = info.jobs.length - done;
    const totalBudget = info.jobs.reduce((s, j) => s + BigInt(j.budget), BigInt(0));
    const volumeNum = info.type === 'usdt' ? Number(totalBudget) / 1e6 : Number(totalBudget) / 1e9;
    const volume = info.type === 'usdt' ? `${volumeNum.toFixed(2)}` : `${volumeNum.toFixed(2)}`;
    return { total: info.jobs.length, done, open, completed: c('COMPLETED'), disputed: c('DISPUTED'), cancelled: c('CANCELLED'), volume, volumeNum };
  }, [info]);

  const agentStats = useMemo(() => {
    if (!info?.jobs.length) return { total: 0, clients: 0, evaluators: 0, providers: 0 };
    const clients = new Set<string>(), evaluators = new Set<string>(), providers = new Set<string>(), all = new Set<string>();
    for (const j of info.jobs) {
      if (j.client) { clients.add(j.client); all.add(j.client); }
      if (j.evaluator) { evaluators.add(j.evaluator); all.add(j.evaluator); }
      if (j.provider && j.provider !== 'none') { providers.add(j.provider); all.add(j.provider); }
    }
    return { total: all.size, clients: clients.size, evaluators: evaluators.size, providers: providers.size };
  }, [info]);

  // Activity: one fixed snapshot
  const activitySnap = useRef<ReturnType<typeof buildActivity>>([]);
  const fresh = useMemo(() => info ? buildActivity(info.jobs, data?.activity?.filter(a => a.type === info.type)) : [], [info, data?.activity]);
  if (fresh.length > 0 && actPage === 0) {
    activitySnap.current = fresh;
  } else if (activitySnap.current.length === 0 && fresh.length > 0) {
    activitySnap.current = fresh;
  }
  const allActivity = activitySnap.current;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' }, { key: 'disputed', label: 'Disputed' }, { key: 'cancelled', label: 'Cancelled' },
  ];

  const filteredJobs = useMemo(() => {
    if (!info) return [];
    let jobs = info.jobs;
    if (tab === 'active') jobs = jobs.filter(j => ['OPEN', 'FUNDED', 'SUBMITTED'].includes(j.stateName));
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
  }, [info, tab, sortBy, sortDir, addrFilter]);

  const toggleSort = (col: 'id' | 'status' | 'budget') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
    setJobPage(0);
  };

  const jobsOnPage = filteredJobs.slice(jobPage * PAGE_SIZE, (jobPage + 1) * PAGE_SIZE);
  const totalJobPages = Math.ceil(filteredJobs.length / PAGE_SIZE) || 1;
  const actTotalPages = Math.ceil(allActivity.length / ACTIVITY_PAGE) || 1;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-[#636370] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors cursor-pointer">← Explorer</Link>
          <span>/</span>
          {info && <span className="text-[#A1A1AA]">{info.label}</span>}
        </div>

        {loading ? (
          <div className="space-y-4">
            <Shimmer className="h-10 w-64 rounded-lg" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Shimmer key={i} className="h-[145px] rounded-xl" />)}</div>
            <Shimmer className="h-48 rounded-xl" />
            <Shimmer className="h-60 rounded-xl" />
          </div>
        ) : !info ? (
          <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-8 text-center">
            <div className="text-[#A1A1AA] text-lg mb-2">Factory not found</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm cursor-pointer">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            {/* Title */}
            <div className="flex items-center gap-3 mb-8">
              <TypeIcon type={info.type} size={32} />
              <h1 className="font-serif italic text-3xl sm:text-4xl text-white explorer-title">{info.label}</h1>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 explorer-stats" style={{ overflow: 'visible' }}>
              <StatCard
                label="Total Jobs"
                value={stats.total}
                sub={<span>{stats.done} done · {stats.open} open</span>}
                sparkline={sparklines.cumJobsTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumJobsTotal} color="#0088CC" meta={{ label: 'jobs', days: sparklines.days }} /> : undefined}
              />
              <StatCard
                label="Total Volume"
                value={<span className="inline-flex items-center gap-1">{stats.volume} <TypeIcon type={info.type} size={20} /></span>}
                sub={<span>{info.type === 'ton' ? 'TON' : 'USDT'} escrowed</span>}
                sparkline={sparklines.cumVolumeTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumVolumeTotal} color="#26A17B" meta={{ label: info.type === 'ton' ? 'TON' : 'USDT', days: sparklines.days }} /> : undefined}
              />
              <StatCard
                label="Completed"
                value={stats.completed}
                sub={<span>of {stats.total} · {stats.disputed} disputed · {stats.cancelled} cancelled</span>}
                sparkline={sparklines.cumJobsTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumJobsTotal.map((_, i) => {
                  // Build cumulative completed count
                  if (!info?.jobs) return 0;
                  const sorted = [...info.jobs].filter(j => j.stateName === 'COMPLETED' && j.createdAt).sort((a, b) => a.createdAt - b.createdAt);
                  return Math.min(sorted.length, Math.round((i / Math.max(sparklines.cumJobsTotal.length - 1, 1)) * sorted.length));
                })} color="#22C55E" meta={{ label: 'completed', days: sparklines.days }} /> : undefined}
              />
              <StatCard
                label="Agents"
                value={agentStats.total}
                sub={<span>{agentStats.clients} clients · {agentStats.evaluators} evaluators · {agentStats.providers} providers</span>}
                sparkline={sparklines.cumAgentsTotal.length > 1 ? <MiniAreaSparkline data={sparklines.cumAgentsTotal} color="#B8860B" meta={{ label: 'agents', days: sparklines.days, details: [{ label: 'Clients', data: sparklines.cumAgentsClients }, { label: 'Evaluators', data: sparklines.cumAgentsEvaluators }, { label: 'Providers', data: sparklines.cumAgentsProviders }] }} /> : undefined}
              />
            </div>

            {/* Latest Activity */}
            {allActivity.length > 0 && (
              <div className="mb-6">
                <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.03)]">
                    <span className="text-white text-sm font-semibold">Latest Activity</span>
                    <InlinePageNav page={actPage} total={actTotalPages} onChange={setActPage} />
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
                            <td className="px-3 py-2 whitespace-nowrap"><span style={{ color: ev.txStatus === 'pending' ? '#F59E0B' : (EVENT_DOT_COLORS[ev.event] || STATUS_COLORS[ev.status] || '#52525B') }} className={`mr-2${ev.txStatus === 'pending' ? ' animate-pulse' : ''}`}>●</span> {ev.event}</td>
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
            )}

            {/* Jobs */}
            <div className="mb-6">
              <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden">
                {/* Jobs header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.03)] gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-white text-sm font-semibold">Jobs ({filteredJobs.length})</span>
                    {/* Desktop: tab pills */}
                    <div className="hidden sm:flex gap-0.5 bg-[rgba(255,255,255,0.05)] rounded-lg p-0.5">
                      {tabs.map(t => (
                        <button key={t.key} onClick={() => { setTab(t.key); setJobPage(0); }}
                          className={`px-3 py-1 text-xs rounded-md transition-colors whitespace-nowrap cursor-pointer font-medium ${tab === t.key ? 'bg-[rgba(0,152,234,0.1)] text-[#0098EA]' : 'text-[#71717A] hover:text-[#A1A1AA]'}`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                    {/* Mobile: dropdown filter button */}
                    <div className="relative sm:hidden">
                      <button onClick={() => setMobileFilterOpen(!mobileFilterOpen)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-[rgba(255,255,255,0.05)] text-[#A1A1AA] cursor-pointer">
                        {tabs.find(t => t.key === tab)?.label}
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
                      </button>
                      {mobileFilterOpen && (
                        <div className="absolute top-full left-0 mt-1 w-[120px] rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0A0A0F] p-1 shadow-xl z-50">
                          {tabs.map(t => (
                            <button key={t.key} onClick={() => { setTab(t.key); setJobPage(0); setMobileFilterOpen(false); }}
                              className={`w-full text-left px-3 py-1.5 text-xs rounded-md cursor-pointer ${tab === t.key ? 'text-[#0098EA]' : 'text-[#A1A1AA] hover:text-white hover:bg-[rgba(255,255,255,0.03)]'}`}>
                              {t.label}
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

function StatCard({ label, value, sub, sparkline }: { label: string; value: React.ReactNode; sub?: React.ReactNode; sparkline?: React.ReactNode }) {
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
