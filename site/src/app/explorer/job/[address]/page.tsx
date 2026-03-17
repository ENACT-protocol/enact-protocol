'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData,
  Badge, Shimmer, TypeIcon, AddrWithActions, Row, ContentBlock, TonscanLink,
  BudgetDisplay, fmtDate, fmtTimeout, truncAddr, tonscanUrl, CopyButton,
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

  const reachedIndex = job ? (job.stateName === 'COMPLETED' ? 3 : job.stateName === 'CANCELLED' ? 1 : job.stateName === 'DISPUTED' ? 2 : TIMELINE_STATES.indexOf(job.stateName)) : -1;
  const isFinal = job ? ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(job.stateName) : false;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-12 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors">← Explorer</Link>
          <span>/</span>
          {job && <span className="text-[#888]">Job #{job.jobId}</span>}
        </div>

        {loading ? (
          <div className="space-y-4"><Shimmer className="h-12 w-64 rounded-lg" />
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6"><Shimmer className="h-80 rounded-xl lg:col-span-3" /><Shimmer className="h-80 rounded-xl lg:col-span-2" /></div>
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
                    <div><div className="text-[#555] text-xs mb-1">Description</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.description} hash={job.descHash} label="description" /></div>
                    </div>
                    <div><div className="text-[#555] text-xs mb-1">Result</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.resultContent} hash={job.resultHash} label="result" /></div>
                    </div>
                    {isFinal && (
                      <div><div className="text-[#555] text-xs mb-1">Evaluation</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm">
                          <span className={job.stateName === 'COMPLETED' ? 'text-[#4ADE80]' : 'text-[#EF4444]'}>
                            {job.stateName === 'COMPLETED' ? '✓ Approved' : job.stateName === 'DISPUTED' ? '✗ Rejected' : '⛔ Cancelled'}
                          </span>
                          {job.reasonContent?.text && <div className="text-[#ccc] mt-1">{job.reasonContent.text}</div>}
                        </div>
                      </div>
                    )}
                  </div>
                </Section>

                {/* Transaction Cards */}
                <Section title="Transactions">
                  <div className="space-y-3">
                    <TxCard color="#4ADE80" label="Created" time={fmtDate(job.createdAt)} jobAddr={job.address}>
                      <TxRow label="Client"><AddrWithActions addr={job.client} truncate long /></TxRow>
                      <TxRow label="Budget"><BudgetDisplay job={job} /></TxRow>
                    </TxCard>

                    {job.state >= 1 && (
                      <TxCard color="#F59E0B" label="Funded" time={fmtDate(job.createdAt)} jobAddr={job.address}>
                        <TxRow label="Amount"><BudgetDisplay job={job} /></TxRow>
                      </TxCard>
                    )}

                    {job.submittedAt > 0 && (
                      <TxCard color="#3B82F6" label="Submitted" time={fmtDate(job.submittedAt)} jobAddr={job.address}>
                        {job.provider && job.provider !== 'none' && <TxRow label="Provider"><AddrWithActions addr={job.provider} truncate long /></TxRow>}
                        {job.resultContent?.text && <TxRow label="Result"><span className="text-[#ccc] text-xs">{job.resultContent.text.slice(0, 80)}{job.resultContent.text.length > 80 ? '...' : ''}</span></TxRow>}
                      </TxCard>
                    )}

                    {job.stateName === 'COMPLETED' && (
                      <TxCard color="#4ADE80" label="Completed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} jobAddr={job.address}>
                        <TxRow label="Evaluator">
                          <span className="inline-flex items-center gap-1.5">
                            <AddrWithActions addr={job.evaluator} truncate long />
                            {job.evaluator === AI_EVALUATOR && <span className="text-xs text-[#3B82F6]">🤖</span>}
                          </span>
                        </TxRow>
                        <TxRow label="Payout"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> → Provider</span></TxRow>
                        {job.reasonContent?.text && <TxRow label="Reason"><span className="text-[#ccc] text-xs">{job.reasonContent.text}</span></TxRow>}
                      </TxCard>
                    )}

                    {job.stateName === 'CANCELLED' && <TxCard color="#6B7280" label="Cancelled" jobAddr={job.address}><TxRow label="Action">Funds refunded to client</TxRow></TxCard>}
                    {job.stateName === 'DISPUTED' && (
                      <TxCard color="#EF4444" label="Disputed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} jobAddr={job.address}>
                        <TxRow label="Evaluator"><AddrWithActions addr={job.evaluator} truncate long /></TxRow>
                        <TxRow label="Action">Result rejected, funds refunded</TxRow>
                      </TxCard>
                    )}
                  </div>
                </Section>
              </div>

              <div className="lg:col-span-2 space-y-6">
                <Section title="Participants">
                  <div className="space-y-4">
                    <div><div className="text-[#555] text-xs mb-1">Client</div><AddrWithActions addr={job.client} truncate long /></div>
                    <div><div className="text-[#555] text-xs mb-1">Provider</div>
                      {job.provider && job.provider !== 'none' ? <AddrWithActions addr={job.provider} truncate long /> : <span className="text-[#555] text-sm">Not assigned</span>}
                    </div>
                    <div><div className="text-[#555] text-xs mb-1">Evaluator</div>
                      <div className="flex items-center gap-2">
                        <AddrWithActions addr={job.evaluator} truncate long />
                        {job.evaluator === AI_EVALUATOR && <span className="text-xs bg-[#3B82F620] text-[#3B82F6] border border-[#3B82F6] rounded px-1.5 py-0.5 font-mono">🤖 AI</span>}
                      </div>
                    </div>
                  </div>
                </Section>

                <Section title="Timeline">
                  <div>
                    {TIMELINE_STATES.map((s, i) => {
                      const reached = i <= reachedIndex;
                      const isCurrent = i === reachedIndex;
                      const finalLabel = isCurrent && isFinal && s === 'COMPLETED' ? job.stateName : s;
                      let time = '';
                      if (s === 'OPEN' && job.createdAt) time = fmtDate(job.createdAt);
                      if (s === 'SUBMITTED' && job.submittedAt) time = fmtDate(job.submittedAt);

                      return (
                        <div key={s} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            {isCurrent && reached
                              ? <div className="w-4 h-4 rounded-full border-2 border-[#4ADE80] bg-[#4ADE8040] shadow-[0_0_8px_#4ADE8060]" />
                              : <div className={`w-3 h-3 rounded-full border-2 ${reached ? 'border-[#4ADE80] bg-[#4ADE8040]' : 'border-[#333]'}`} />}
                            {i < TIMELINE_STATES.length - 1 && (
                              i < reachedIndex
                                ? <div className="w-px h-8 bg-[#4ADE80]" />
                                : <div className="w-px h-8 border-l border-dashed border-[#333]" />
                            )}
                          </div>
                          <div className="pb-6 flex items-start gap-2">
                            <div>
                              <div className={`text-sm ${reached ? 'text-white' : 'text-[#555]'}`}>{finalLabel}</div>
                              {time && <div className="text-[#555] text-xs">{time}</div>}
                            </div>
                            {reached && <TonscanLink addr={job.address} size={12} />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              </div>
            </div>

            <div className="mt-4">
              <button onClick={() => setShowTech(!showTech)} className="flex items-center gap-2 text-xs text-[#555] hover:text-[#888] transition-colors font-mono">
                <span className={`transform transition-transform ${showTech ? 'rotate-90' : ''}`}>▶</span> Technical Details
              </button>
              {showTech && (
                <div className="mt-3 bg-[#111] border border-[#222] rounded-xl p-5 text-[13px] text-[#555] font-mono space-y-1">
                  {[['jobId', job.jobId], ['state', `${job.state} (${job.stateName})`], ['descHash', job.descHash], ['resultHash', job.resultHash],
                    ['timeout', job.timeout], ['evalTimeout', job.evalTimeout], ['createdAt', job.createdAt], ['submittedAt', job.submittedAt],
                    ['budget (raw)', job.budget], ['factory', job.type === 'ton' ? FACTORY : JETTON_FACTORY]].map(([k, v]) => (
                    <div key={String(k)} className="flex gap-3"><span className="text-[#444] w-28 shrink-0">{String(k)}</span><span className="text-[#555] break-all">{String(v)}</span></div>
                  ))}
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
  return <div className="bg-[#111] border border-[#222] rounded-xl p-5"><div className="text-[#555] text-xs font-mono mb-4 uppercase tracking-wider">{title}</div>{children}</div>;
}

function TxCard({ color, label, time, jobAddr, children }: { color: string; label: string; time?: string; jobAddr: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-4 bg-[#0a0a0a]" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color }} className="text-lg leading-none">●</span>
          <span className="text-white text-sm font-medium">{label}</span>
        </div>
        <TonscanLink addr={jobAddr} />
      </div>
      {time && <div className="text-[#555] text-xs mb-2">{time}</div>}
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TxRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2 text-sm"><span className="text-[#555] w-20 shrink-0">{label}</span><span className="text-[#ccc] min-w-0">{children}</span></div>;
}
