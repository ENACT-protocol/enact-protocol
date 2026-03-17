'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData,
  Badge, Shimmer, TypeIcon, AddrWithActions, Row,
  LiveTimer, BudgetDisplay, fmtDate, fmtTimeout, decodeHexContent,
} from '../../shared';

const TIMELINE_STATES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED'];

export default function JobPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const [showTech, setShowTech] = useState(false);

  const job = useMemo(() => {
    if (!data) return null;
    return [...data.tonJobs, ...data.jettonJobs].find(j => j.address === address) ?? null;
  }, [data, address]);

  const zeroHash = '0'.repeat(64);

  function renderContent(hash: string, label: string) {
    if (!hash || hash === zeroHash) return <span className="text-[#555]">—</span>;
    const decoded = decodeHexContent(hash);
    if (decoded) return <span className="text-[#ccc]">{decoded}</span>;
    return <span className="text-[#555] font-mono text-xs">On-chain hash: {hash.slice(0, 20)}...</span>;
  }

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors">← Explorer</Link>
          <span>/</span>
          {job && <span className="text-[#888]">Job #{job.jobId}</span>}
        </div>

        {loading ? (
          <div className="space-y-4">
            <Shimmer className="h-12 w-64 rounded-lg" />
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <Shimmer className="h-80 rounded-xl lg:col-span-3" />
              <Shimmer className="h-80 rounded-xl lg:col-span-2" />
            </div>
          </div>
        ) : !job ? (
          <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center">
            <div className="text-[#888] text-lg mb-2">Job not found</div>
            <div className="text-[#555] text-sm font-mono mb-4">{address}</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 mb-8 flex-wrap">
              <h1 className="font-serif text-3xl text-white">Job #{job.jobId}</h1>
              <Badge status={job.stateName} />
              <TypeIcon type={job.type} size={20} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Left column (60%) */}
              <div className="lg:col-span-3 space-y-6">
                {/* Overview */}
                <Section title="Overview">
                  <div className="space-y-3">
                    <Row label="Address"><AddrWithActions addr={job.address} /></Row>
                    <Row label="Factory">{job.type === 'ton' ? 'JobFactory (TON)' : 'JettonJobFactory (USDT)'}</Row>
                    <Row label="Status"><Badge status={job.stateName} /></Row>
                    <Row label="Budget"><span className="text-white font-medium"><BudgetDisplay job={job} /></span></Row>
                    <Row label="Created">{fmtDate(job.createdAt)}</Row>
                    <Row label="Timeout">{fmtTimeout(job.timeout)} (eval: {fmtTimeout(job.evalTimeout)})</Row>
                  </div>
                </Section>

                {/* Content */}
                <Section title="Content">
                  <div className="space-y-4">
                    <div>
                      <div className="text-[#555] text-xs mb-1">Description</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm">{renderContent(job.descHash, 'description')}</div>
                    </div>
                    <div>
                      <div className="text-[#555] text-xs mb-1">Result</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm">{renderContent(job.resultHash, 'result')}</div>
                    </div>
                  </div>
                </Section>
              </div>

              {/* Right column (40%) */}
              <div className="lg:col-span-2 space-y-6">
                {/* Participants */}
                <Section title="Participants">
                  <div className="space-y-3">
                    <div>
                      <div className="text-[#555] text-xs mb-1">Client</div>
                      <AddrWithActions addr={job.client} truncate />
                    </div>
                    <div>
                      <div className="text-[#555] text-xs mb-1">Provider</div>
                      {job.provider && job.provider !== 'none'
                        ? <AddrWithActions addr={job.provider} truncate />
                        : <span className="text-[#555] text-sm">Not assigned</span>}
                    </div>
                    <div>
                      <div className="text-[#555] text-xs mb-1">Evaluator</div>
                      <div className="flex items-center gap-2">
                        <AddrWithActions addr={job.evaluator} truncate />
                        {job.evaluator === AI_EVALUATOR && <span title="AI Evaluator" className="text-xs">🤖</span>}
                      </div>
                      {job.evaluator === AI_EVALUATOR && <div className="text-[#555] text-xs mt-0.5">AI Evaluator</div>}
                    </div>
                  </div>
                </Section>

                {/* Timeline */}
                <Section title="Timeline">
                  <div className="space-y-0">
                    {TIMELINE_STATES.map((s, i) => {
                      const stateIdx = TIMELINE_STATES.indexOf(job.stateName);
                      const reached = job.state >= i || (job.stateName === 'CANCELLED' && i <= 1) || (job.stateName === 'DISPUTED' && i <= 2);
                      const isCurrent = s === job.stateName || (s === 'COMPLETED' && (job.stateName === 'CANCELLED' || job.stateName === 'DISPUTED'));
                      const finalLabel = isCurrent && job.stateName !== s ? job.stateName : s;

                      let date = '';
                      if (s === 'OPEN' && job.createdAt) date = fmtDate(job.createdAt);
                      if (s === 'SUBMITTED' && job.submittedAt) date = fmtDate(job.submittedAt);

                      return (
                        <div key={s} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className={`w-3 h-3 rounded-full border-2 ${reached ? 'border-[#4ADE80] bg-[#4ADE8040]' : 'border-[#333] bg-transparent'}`} />
                            {i < TIMELINE_STATES.length - 1 && <div className={`w-px h-8 ${reached && i < stateIdx ? 'bg-[#4ADE80]' : 'bg-[#222]'}`} />}
                          </div>
                          <div className="pb-6">
                            <div className={`text-sm ${reached ? 'text-white' : 'text-[#555]'}`}>
                              {finalLabel}
                            </div>
                            {date && <div className="text-[#555] text-xs">{date}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              </div>
            </div>

            {/* Technical Details */}
            <div className="mt-6">
              <button onClick={() => setShowTech(!showTech)}
                className="flex items-center gap-2 text-xs text-[#555] hover:text-[#888] transition-colors font-mono">
                <span className={`transform transition-transform ${showTech ? 'rotate-90' : ''}`}>▶</span>
                Technical Details
              </button>
              {showTech && (
                <div className="mt-3 bg-[#111] border border-[#222] rounded-xl p-5 text-[13px] text-[#555] font-mono space-y-1.5">
                  <TRow label="jobId">{job.jobId}</TRow>
                  <TRow label="state">{job.state} ({job.stateName})</TRow>
                  <TRow label="descHash"><span className="break-all">{job.descHash}</span></TRow>
                  <TRow label="resultHash"><span className="break-all">{job.resultHash}</span></TRow>
                  <TRow label="timeout">{job.timeout}</TRow>
                  <TRow label="evalTimeout">{job.evalTimeout}</TRow>
                  <TRow label="createdAt">{job.createdAt}</TRow>
                  <TRow label="submittedAt">{job.submittedAt}</TRow>
                  <TRow label="budget (raw)">{job.budget}</TRow>
                  <TRow label="factory">{job.type === 'ton' ? FACTORY : JETTON_FACTORY}</TRow>
                  <div className="pt-3 mt-3 border-t border-[#1a1a1a] text-[#444] space-y-1">
                    <div>Main Cell: jobId · factory · client · provider · state</div>
                    <div>Details: evaluator · budget · descHash · resultHash</div>
                    <div>Extension: timeout · createdAt · evalTimeout · submittedAt</div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-5">
      <div className="text-[#555] text-xs font-mono mb-4 uppercase tracking-wider">{title}</div>
      {children}
    </div>
  );
}

function TRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[#444] w-28 shrink-0">{label}</span>
      <span className="text-[#555]">{children}</span>
    </div>
  );
}
