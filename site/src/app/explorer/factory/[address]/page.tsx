'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  FACTORY, JETTON_FACTORY, useExplorerData,
  Badge, Shimmer, TypeIcon, AddrWithActions, Row,
  LiveTimer, BudgetDisplay, truncAddr, fmtDateShort,
} from '../../shared';

export default function FactoryPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const router = useRouter();

  const factoryInfo = useMemo(() => {
    if (!data) return null;
    if (address === FACTORY) return { label: 'JobFactory', type: 'ton' as const, ...data.factories.ton, jobs: data.tonJobs };
    if (address === JETTON_FACTORY) return { label: 'JettonJobFactory', type: 'usdt' as const, ...data.factories.jetton, jobs: data.jettonJobs };
    return null;
  }, [data, address]);

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors">← Explorer</Link>
          <span>/</span>
          {factoryInfo && <span className="text-[#888]">{factoryInfo.label}</span>}
        </div>

        {loading ? (
          <div className="space-y-4">
            <Shimmer className="h-12 w-64 rounded-lg" />
            <Shimmer className="h-40 rounded-xl" />
            <Shimmer className="h-60 rounded-xl" />
          </div>
        ) : !factoryInfo ? (
          <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center">
            <div className="text-[#888] text-lg mb-2">Factory not found</div>
            <div className="text-[#555] text-sm font-mono mb-4">{address}</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
              <TypeIcon type={factoryInfo.type} size={28} />
              <h1 className="font-serif text-3xl text-white">{factoryInfo.label}</h1>
            </div>

            {/* Factory Info */}
            <div className="bg-[#111] border border-[#222] rounded-xl p-5 mb-8">
              <div className="space-y-3">
                <Row label="Address"><AddrWithActions addr={factoryInfo.address} /></Row>
                <Row label="Type">{factoryInfo.type === 'ton' ? 'TON Escrow' : 'USDT/Jetton Escrow'}</Row>
                <Row label="Total Jobs"><span className="text-white font-medium">{factoryInfo.jobCount}</span></Row>
                <Row label="Network">Mainnet</Row>
              </div>
            </div>

            {/* Jobs */}
            <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Jobs ({factoryInfo.jobs.length})</div>
            <div className="bg-[#111] border border-[#222] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a1a] text-[#555] text-xs font-mono uppercase">
                    <th className="text-left px-4 py-3">#</th>
                    <th className="text-left px-4 py-3 hidden sm:table-cell">Address</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Budget</th>
                    <th className="text-left px-4 py-3 hidden md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {factoryInfo.jobs.length === 0 && <tr><td colSpan={5} className="text-center text-[#555] py-8">No jobs yet</td></tr>}
                  {[...factoryInfo.jobs].reverse().map(job => (
                    <tr key={job.address} onClick={() => router.push(`/explorer/job/${job.address}`)}
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
