'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData,
  Badge, Shimmer, TypeIcon, AddrWithActions, Row, ContentDisplay,
  BudgetDisplay, fmtDate, fmtTimeout, truncAddr, CopyButton,
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

  const stateIndex = job ? TIMELINE_STATES.indexOf(job.stateName) : -1;
  const isFinal = job ? ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(job.stateName) : false;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-16 px-4 sm:px-6 max-w-[1200px] mx-auto">
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
            <div className="text-[#555] text-sm font-mono mb-4 break-all">{address}</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-8 flex-wrap">
              <h1 className="font-serif text-3xl text-white">Job #{job.jobId}</h1>
              <Badge status={job.stateName} />
              <TypeIcon type={job.type} size={20} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Left column */}
              <div className="lg:col-span-3 space-y-6">
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

                <Section title="Content">
                  <div className="space-y-4">
                    <ContentBlock label="Description" hash={job.descHash} />
                    <ContentBlock label="Result" hash={job.resultHash} />
                  </div>
                </Section>

                {/* Transactions */}
                <Section title="Transactions">
                  <div className="space-y-0">
                    <TxEvent reached={true} label="Created" time={fmtDate(job.createdAt)} detail={`Client created job with ${job.budgetFormatted} budget`} last={job.state === 0} />
                    <TxEvent reached={job.state >= 1} label="Funded" time={job.state >= 1 ? fmtDate(job.createdAt) : undefined} detail={`Budget: ${job.budgetFormatted}`} last={job.state === 1 && !isFinal} />
                    <TxEvent reached={!!job.submittedAt} label="Submitted" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} detail={job.submittedAt ? `Result hash: ${job.resultHash.slice(0, 16)}...` : undefined} last={job.state === 2 && !isFinal} />
                    {job.stateName === 'COMPLETED' && <TxEvent reached={true} label="Completed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} detail={`Payout: ${job.budgetFormatted} → Provider`} last={true} color="#4ADE80" />}
                    {job.stateName === 'CANCELLED' && <TxEvent reached={true} label="Cancelled" time={undefined} detail="Funds refunded to client" last={true} color="#6B7280" />}
                    {job.stateName === 'DISPUTED' && <TxEvent reached={true} label="Disputed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} detail="Result rejected, funds refunded" last={true} color="#EF4444" />}
                  </div>
                </Section>
              </div>

              {/* Right column */}
              <div className="lg:col-span-2 space-y-6">
                <Section title="Participants">
                  <div className="space-y-4">
                    <div>
                      <div className="text-[#555] text-xs mb-1">Client</div>
                      <AddrWithActions addr={job.client} truncate long />
                    </div>
                    <div>
                      <div className="text-[#555] text-xs mb-1">Provider</div>
                      {job.provider && job.provider !== 'none'
                        ? <AddrWithActions addr={job.provider} truncate long />
                        : <span className="text-[#555] text-sm">Not assigned</span>}
                    </div>
                    <div>
                      <div className="text-[#555] text-xs mb-1">Evaluator</div>
                      <div className="flex items-center gap-2">
                        <AddrWithActions addr={job.evaluator} truncate long />
                        {job.evaluator === AI_EVALUATOR && <span className="text-xs bg-[#3B82F620] text-[#3B82F6] border border-[#3B82F6] rounded px-1.5 py-0.5 font-mono">🤖 AI</span>}
                      </div>
                      {job.evaluator === AI_EVALUATOR && <div className="text-[#555] text-xs mt-0.5">AI Evaluator</div>}
                    </div>
                  </div>
                </Section>

                <Section title="Timeline">
                  <div className="space-y-0">
                    {TIMELINE_STATES.map((s, i) => {
                      const reached = job.state >= i;
                      const isCurrent = (i === stateIndex) || (isFinal && i === TIMELINE_STATES.length - 1);
                      const finalLabel = isCurrent && isFinal && s === 'COMPLETED' ? job.stateName : s;

                      let time = '';
                      if (s === 'OPEN' && job.createdAt) time = fmtDate(job.createdAt);
                      if (s === 'SUBMITTED' && job.submittedAt) time = fmtDate(job.submittedAt);

                      return (
                        <div key={s} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            {isCurrent && reached ? (
                              <div className="w-4 h-4 rounded-full border-2 border-[#4ADE80] bg-[#4ADE8040] shadow-[0_0_8px_#4ADE8060]" />
                            ) : (
                              <div className={`w-3 h-3 rounded-full border-2 ${reached ? 'border-[#4ADE80] bg-[#4ADE8040]' : 'border-[#333]'}`} />
                            )}
                            {i < TIMELINE_STATES.length - 1 && (
                              <div className={`w-px h-8 ${reached && i < (stateIndex >= 0 ? stateIndex : 999) ? 'bg-[#4ADE80]' : 'border-l border-dashed border-[#333]'}`} />
                            )}
                          </div>
                          <div className="pb-6">
                            <div className={`text-sm ${reached ? 'text-white' : 'text-[#555]'}`}>{finalLabel}</div>
                            {time && <div className="text-[#555] text-xs">{time}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              </div>
            </div>

            {/* Technical Details */}
            <div className="mt-4">
              <button onClick={() => setShowTech(!showTech)}
                className="flex items-center gap-2 text-xs text-[#555] hover:text-[#888] transition-colors font-mono">
                <span className={`transform transition-transform ${showTech ? 'rotate-90' : ''}`}>▶</span>
                Technical Details
              </button>
              {showTech && (
                <div className="mt-3 bg-[#111] border border-[#222] rounded-xl p-5 text-[13px] text-[#555] font-mono space-y-1">
                  <TR label="jobId">{job.jobId}</TR>
                  <TR label="state">{job.state} ({job.stateName})</TR>
                  <TR label="descHash"><span className="break-all">{job.descHash}</span></TR>
                  <TR label="resultHash"><span className="break-all">{job.resultHash}</span></TR>
                  <TR label="timeout">{job.timeout}</TR>
                  <TR label="evalTimeout">{job.evalTimeout}</TR>
                  <TR label="createdAt">{job.createdAt}</TR>
                  <TR label="submittedAt">{job.submittedAt}</TR>
                  <TR label="budget (raw)">{job.budget}</TR>
                  <TR label="factory">{job.type === 'ton' ? FACTORY : JETTON_FACTORY}</TR>
                  <div className="pt-2 mt-2 border-t border-[#1a1a1a] text-[#444] space-y-0.5">
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

function TR({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[#444] w-28 shrink-0">{label}</span>
      <span className="text-[#555]">{children}</span>
    </div>
  );
}

function ContentBlock({ label, hash }: { label: string; hash: string }) {
  const [expanded, setExpanded] = useState(false);
  const zeroHash = '0'.repeat(64);
  const hasContent = hash && hash !== zeroHash;

  return (
    <div>
      <div className="text-[#555] text-xs mb-1">{label}</div>
      <div className={`bg-[#0a0a0a] rounded-lg p-3 text-sm relative ${!expanded && hasContent ? 'max-h-[200px] overflow-hidden' : ''}`}>
        <ContentDisplay hash={hash} label={label} />
        {!expanded && hasContent && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#0a0a0a] to-transparent flex items-end justify-center pb-1">
            <button onClick={() => setExpanded(true)} className="text-xs text-[#0098EA] hover:underline">Show full</button>
          </div>
        )}
      </div>
      {expanded && hasContent && (
        <button onClick={() => setExpanded(false)} className="text-xs text-[#555] hover:text-[#888] mt-1">Collapse</button>
      )}
    </div>
  );
}

function TxEvent({ reached, label, time, detail, last, color }: {
  reached: boolean; label: string; time?: string; detail?: string; last?: boolean; color?: string;
}) {
  if (!reached) return null;
  const dotColor = color ?? '#4ADE80';
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: dotColor + '60', border: `2px solid ${dotColor}` }} />
        {!last && <div className="w-px h-full min-h-[32px]" style={{ backgroundColor: dotColor }} />}
      </div>
      <div className="pb-4">
        <div className="text-white text-sm font-medium">{label}</div>
        {time && <div className="text-[#555] text-xs">{time}</div>}
        {detail && <div className="text-[#666] text-xs mt-0.5">{detail}</div>}
      </div>
    </div>
  );
}
