'use client';

import { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, ClickAddr, Row, TonscanLink,
  BudgetDisplay, truncAddr, fmtDateShort, timeAgo, STATUS_COLORS, EVENT_DOT_COLORS, AIBadge,
} from '../../shared';
import { FactoryCharts } from '../../Charts';

const ACT_PAGE = 15;

export default function FactoryPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const router = useRouter();
  const [actPage, setActPage] = useState(0);

  const info = useMemo(() => {
    if (!data) return null;
    if (address === FACTORY) return { label: 'JobFactory', type: 'ton' as const, ...data.factories.ton, jobs: data.tonJobs };
    if (address === JETTON_FACTORY) return { label: 'JettonJobFactory', type: 'usdt' as const, ...data.factories.jetton, jobs: data.jettonJobs };
    return null;
  }, [data, address]);

  const stats = useMemo(() => {
    if (!info) return { open: 0, funded: 0, submitted: 0, completed: 0, disputed: 0, cancelled: 0, volume: '0' };
    const c = (s: string) => info.jobs.filter(j => j.stateName === s).length;
    const totalBudget = info.jobs.reduce((s, j) => s + BigInt(j.budget), BigInt(0));
    const volume = info.type === 'usdt' ? `${(Number(totalBudget) / 1e6).toFixed(2)} USDT` : `${(Number(totalBudget) / 1e9).toFixed(2)} TON`;
    return { open: c('OPEN'), funded: c('FUNDED'), submitted: c('SUBMITTED'), completed: c('COMPLETED'), disputed: c('DISPUTED'), cancelled: c('CANCELLED'), volume };
  }, [info]);

  const activity = useMemo(() => info ? buildActivity(info.jobs, data?.activity?.filter(a => a.type === info.type)) : [], [info, data?.activity]);
  const actOnPage = activity.slice(actPage * ACT_PAGE, (actPage + 1) * ACT_PAGE);
  const actTotalPages = Math.ceil(activity.length / ACT_PAGE) || 1;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-12 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors cursor-pointer">← Explorer</Link>
          <span>/</span>
          {info && <span className="text-[#888]">{info.label}</span>}
        </div>

        {loading ? (
          <div className="space-y-4"><Shimmer className="h-12 w-64 rounded-lg" /><Shimmer className="h-40 rounded-xl" /><Shimmer className="h-60 rounded-xl" /></div>
        ) : !info ? (
          <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center">
            <div className="text-[#888] text-lg mb-2">Factory not found</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm cursor-pointer">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-8">
              <TypeIcon type={info.type} size={32} />
              <h1 className="font-serif text-3xl text-white">{info.label}</h1>
            </div>

            {/* Factory Info + Stats */}
            <div className="bg-[#111] border border-[#222] rounded-xl p-5 mb-6">
              <div className="space-y-3 mb-5">
                <Row label="Address"><ClickAddr addr={info.address} /></Row>
                <Row label="Type">{info.type === 'ton' ? 'TON Escrow' : 'USDT/Jetton Escrow'}</Row>
                <Row label="Network">Mainnet</Row>
              </div>
              <div className="border-t border-[#1a1a1a] pt-4">
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <span className="text-[#ccc]"><span className="text-[#555]">Total:</span> {info.jobCount}</span>
                  <span style={{ color: '#FACC15' }}><span className="text-[#555]">Open:</span> {stats.open}</span>
                  <span style={{ color: '#60A5FA' }}><span className="text-[#555]">Funded:</span> {stats.funded}</span>
                  <span style={{ color: '#A78BFA' }}><span className="text-[#555]">Submitted:</span> {stats.submitted}</span>
                  <span style={{ color: '#4ADE80' }}><span className="text-[#555]">Completed:</span> {stats.completed}</span>
                  <span style={{ color: '#EF4444' }}><span className="text-[#555]">Disputed:</span> {stats.disputed}</span>
                  <span style={{ color: '#6B7280' }}><span className="text-[#555]">Cancelled:</span> {stats.cancelled}</span>
                  <span className="text-[#ccc]"><span className="text-[#555]">Volume:</span> {stats.volume}</span>
                </div>
              </div>
            </div>

            {/* Charts */}
            <FactoryCharts jobs={info.jobs} type={info.type} />

            {/* Latest Activity — same as main explorer */}
            {activity.length > 0 && (
              <div className="mb-6">
                <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Latest Activity</div>
                <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
                  <table className="w-full text-sm explorer-table">
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
                      {actOnPage.map((ev, i) => (
                        <tr key={`act-${i}`} onClick={() => router.push(`/explorer/job/${ev.address}`)}
                          className="border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors">
                          <td className="px-3 py-2 whitespace-nowrap"><span className="text-white">#{ev.jobId}</span> <TypeIcon type={ev.type} size={14} /></td>
                          <td className="px-3 py-2 whitespace-nowrap"><span style={{ color: EVENT_DOT_COLORS[ev.event] || STATUS_COLORS[ev.status] || '#555' }} className="mr-1.5">●</span>{ev.event}</td>
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
                <Pager page={actPage} total={actTotalPages} onChange={setActPage} />
              </div>
            )}

            {/* Jobs Table — same as main explorer */}
            <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Jobs ({info.jobs.length})</div>
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
              <table className="w-full text-sm explorer-table">
                <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-[11px] font-mono uppercase tracking-[1px] font-medium">
                  <th className="text-left px-3 py-2.5">#</th>
                  <th className="text-left px-3 py-2.5 hidden sm:table-cell">Address</th>
                  <th className="text-left px-3 py-2.5">Status</th>
                  <th className="text-left px-3 py-2.5">Budget</th>
                  <th className="text-left px-3 py-2.5 hidden md:table-cell">Client</th>
                  <th className="text-left px-3 py-2.5 hidden lg:table-cell">Evaluator</th>
                  <th className="text-left px-3 py-2.5 hidden md:table-cell">Txns</th>
                  <th className="text-left px-3 py-2.5 hidden md:table-cell">Created</th>
                </tr></thead>
                <tbody>
                  {[...info.jobs].reverse().map(job => (
                    <tr key={job.address} onClick={() => router.push(`/explorer/job/${job.address}`)}
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
          </>
        )}
      </main>
      <Footer />
    </>
  );
}


function Pager({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-2 mt-4" aria-label="Pagination">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} aria-label="Previous page" className="px-3 py-1.5 text-sm rounded border border-[#222] text-[#888] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&larr;</button>
      <span className="text-[#555] text-sm" aria-live="polite">{page + 1} / {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1} aria-label="Next page" className="px-3 py-1.5 text-sm rounded border border-[#222] text-[#888] hover:text-white hover:border-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">&rarr;</button>
    </nav>
  );
}
