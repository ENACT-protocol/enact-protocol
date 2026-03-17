'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, useExplorerData, buildActivity, txCount,
  Badge, Shimmer, TypeIcon, AddrWithActions, Row, TonscanLink, CopyButton,
  LiveTimer, BudgetDisplay, truncAddr, fmtDateShort, tonscanUrl, timeAgo, STATUS_COLORS,
} from '../../shared';

export default function FactoryPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const router = useRouter();

  const info = useMemo(() => {
    if (!data) return null;
    if (address === FACTORY) return { label: 'JobFactory', type: 'ton' as const, ...data.factories.ton, jobs: data.tonJobs };
    if (address === JETTON_FACTORY) return { label: 'JettonJobFactory', type: 'usdt' as const, ...data.factories.jetton, jobs: data.jettonJobs };
    return null;
  }, [data, address]);

  const stats = useMemo(() => {
    if (!info) return { active: 0, completed: 0, volume: '0' };
    const active = info.jobs.filter(j => ['OPEN', 'FUNDED', 'SUBMITTED'].includes(j.stateName)).length;
    const completed = info.jobs.filter(j => j.stateName === 'COMPLETED').length;
    const totalBudget = info.jobs.reduce((s, j) => s + BigInt(j.budget), BigInt(0));
    const volume = info.type === 'usdt' ? `${(Number(totalBudget) / 1e6).toFixed(2)} USDT` : `${(Number(totalBudget) / 1e9).toFixed(2)} TON`;
    return { active, completed, volume };
  }, [info]);

  const activity = useMemo(() => info ? buildActivity(info.jobs).slice(0, 10) : [], [info]);

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-12 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors">← Explorer</Link>
          <span>/</span>
          {info && <span className="text-[#888]">{info.label}</span>}
        </div>

        {loading ? (
          <div className="space-y-4"><Shimmer className="h-12 w-64 rounded-lg" /><Shimmer className="h-40 rounded-xl" /><Shimmer className="h-60 rounded-xl" /></div>
        ) : !info ? (
          <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center">
            <div className="text-[#888] text-lg mb-2">Factory not found</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-8"><TypeIcon type={info.type} size={28} /><h1 className="font-serif text-3xl text-white">{info.label}</h1></div>

            <div className="bg-[#111] border border-[#222] rounded-xl p-5 mb-6">
              <div className="space-y-3">
                <Row label="Address"><AddrWithActions addr={info.address} /></Row>
                <Row label="Type">{info.type === 'ton' ? 'TON Escrow' : 'USDT/Jetton Escrow'}</Row>
                <Row label="Network">Mainnet</Row>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="bg-[#111] border border-[#222] rounded-xl p-4">
                <div className="text-[#555] text-xs font-mono uppercase">Total Jobs</div>
                <div className="text-white text-2xl font-semibold mt-1">{info.jobCount}</div>
              </div>
              <div className="bg-[#111] border border-[#222] rounded-xl p-4">
                <div className="text-[#555] text-xs font-mono uppercase">Active</div>
                <div className="text-white text-2xl font-semibold mt-1">{stats.active}</div>
              </div>
              <div className="bg-[#111] border border-[#222] rounded-xl p-4">
                <div className="text-[#555] text-xs font-mono uppercase">Completed</div>
                <div className="text-white text-2xl font-semibold mt-1">{stats.completed}</div>
              </div>
              <div className="bg-[#111] border border-[#222] rounded-xl p-4">
                <div className="text-[#555] text-xs font-mono uppercase">Total Volume</div>
                <div className="text-white text-xl font-semibold mt-1 flex items-center gap-1">{stats.volume}</div>
              </div>
            </div>

            {/* Latest Activity */}
            {activity.length > 0 && (
              <div className="mb-6">
                <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Latest Activity</div>
                <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-xs font-mono uppercase">
                      <th className="text-left px-4 py-2.5">Event</th><th className="text-left px-4 py-2.5">Job</th>
                      <th className="text-left px-4 py-2.5 hidden sm:table-cell">From</th><th className="text-left px-4 py-2.5">Time</th>
                    </tr></thead>
                    <tbody>
                      {activity.map((ev, i) => (
                        <tr key={i} onClick={() => router.push(`/explorer/job/${ev.address}`)} className="border-b border-[#1a1a1a] last:border-0 cursor-pointer hover:bg-[#151515] transition-colors">
                          <td className="px-4 py-2.5"><span style={{ color: STATUS_COLORS[ev.status] }} className="mr-1.5">●</span>{ev.event}</td>
                          <td className="px-4 py-2.5 text-white">#{ev.jobId}</td>
                          <td className="px-4 py-2.5 hidden sm:table-cell font-mono text-xs text-[#888]">{truncAddr(ev.from)}</td>
                          <td className="px-4 py-2.5 text-[#555] text-xs">{timeAgo(ev.time)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Jobs Table */}
            <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Jobs ({info.jobs.length})</div>
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[#1a1a1a] text-[#555] text-xs font-mono uppercase">
                  <th className="text-left px-4 py-3">#</th>
                  <th className="text-left px-4 py-3 hidden sm:table-cell">Address</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Budget</th>
                  <th className="text-left px-4 py-3 hidden md:table-cell">Client</th>
                  <th className="text-left px-4 py-3 hidden md:table-cell">Created</th>
                </tr></thead>
                <tbody>
                  {[...info.jobs].reverse().map(job => (
                    <tr key={job.address} onClick={() => router.push(`/explorer/job/${job.address}`)}
                      className="border-b border-[#1a1a1a] cursor-pointer hover:bg-[#151515] transition-colors">
                      <td className="px-4 py-3 text-white font-medium"><span className="inline-flex items-center gap-1.5">#{job.jobId} <TypeIcon type={job.type} size={14} /></span></td>
                      <td className="px-4 py-3 font-mono text-xs text-[#888] hidden sm:table-cell">{truncAddr(job.address)}</td>
                      <td className="px-4 py-3"><Badge status={job.stateName} /></td>
                      <td className="px-4 py-3 text-[#ccc]"><BudgetDisplay job={job} /></td>
                      <td className="px-4 py-3 hidden md:table-cell font-mono text-xs text-[#888]">{truncAddr(job.client)}</td>
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
