'use client';

import { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, ClickAddr, Row, TonscanLink,
  BudgetDisplay, truncAddr, fmtDateShort, timeAgo, STATUS_COLORS, AIBadge,
} from '../../shared';

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

  const activity = useMemo(() => info ? buildActivity(info.jobs) : [], [info]);
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

            {/* Factory Info */}
            <div className="bg-[#111] border border-[#222] rounded-xl p-5 mb-6">
              <div className="space-y-3">
                <Row label="Address"><ClickAddr addr={info.address} /></Row>
                <Row label="Type">{info.type === 'ton' ? 'TON Escrow' : 'USDT/Jetton Escrow'}</Row>
                <Row label="Network">Mainnet</Row>
              </div>
            </div>

            {/* Stats — all states */}
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
              <SC label="Total" value={info.jobCount} />
              <SC label="Open" value={stats.open} color="#4ADE80" />
              <SC label="Funded" value={stats.funded} color="#F59E0B" />
              <SC label="Submitted" value={stats.submitted} color="#3B82F6" />
              <SC label="Completed" value={stats.completed} color="#4ADE80" />
              <SC label="Disputed" value={stats.disputed} color="#EF4444" />
              <SC label="Cancelled" value={stats.cancelled} color="#6B7280" />
              <SC label="Volume" value={stats.volume} />
            </div>

            {/* Latest Activity — same as main explorer */}
            {activity.length > 0 && (
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
                      {actOnPage.map((ev, i) => (
                        <tr key={`act-${i}`} onClick={() => router.push(`/explorer/job/${ev.address}`)}
                          className="border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors">
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
                <Pager page={actPage} total={actTotalPages} onChange={setActPage} />
              </div>
            )}

            {/* Jobs Table — same as main explorer */}
            <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Jobs ({info.jobs.length})</div>
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
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

function SC({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-3">
      <div className="text-[#555] text-[10px] font-mono uppercase">{label}</div>
      <div className="text-white text-lg font-semibold mt-0.5" style={color ? { color } : undefined}>{value}</div>
    </div>
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
