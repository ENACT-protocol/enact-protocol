'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, STATUS_COLORS, GAS_COSTS,
  Badge, Shimmer, TypeIcon, TonIcon, ClickAddr, Row, ContentBlock, TonscanLink, AIBadge, CopyHash,
  BudgetDisplay, fmtDate, fmtTimeout,
} from '../../shared';

const TL_STATES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED'];

export default function JobPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();
  const [showTech, setShowTech] = useState(false);

  const job = useMemo(() => {
    if (!data) return null;
    return [...data.tonJobs, ...data.jettonJobs].find(j => j.address === address) ?? null;
  }, [data, address]);

  const reachedIdx = job ? (['COMPLETED','CANCELLED','DISPUTED'].includes(job.stateName)
    ? (job.stateName === 'CANCELLED' ? 1 : job.stateName === 'COMPLETED' ? 3 : 2)
    : TL_STATES.indexOf(job.stateName)) : -1;
  const isFinal = job ? ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(job.stateName) : false;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-12 px-4 sm:px-6 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-2 text-sm text-[#555] mb-6">
          <Link href="/explorer" className="hover:text-white transition-colors cursor-pointer">← Explorer</Link>
          <span>/</span>
          {job && <span className="text-[#888]">Job #{job.jobId}</span>}
        </div>

        {loading ? (
          <div className="space-y-4"><Shimmer className="h-12 w-64 rounded-lg" />
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4"><Shimmer className="h-80 rounded-xl lg:col-span-3" /><Shimmer className="h-80 rounded-xl lg:col-span-2" /></div>
          </div>
        ) : !job ? (
          <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center">
            <div className="text-[#888] text-lg mb-2">Job not found</div>
            <div className="text-[#555] text-sm font-mono mb-4 break-all">{address}</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm cursor-pointer">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-6 flex-wrap">
              <h1 className="font-serif text-3xl text-white">Job #{job.jobId}</h1>
              <Badge status={job.stateName} />
              <TypeIcon type={job.type} size={20} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
              <div className="lg:col-span-3 space-y-4">
                <Section title="Overview">
                  <div className="space-y-3">
                    <Row label="Address"><ClickAddr addr={job.address} /></Row>
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
                      <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.description} hash={job.descHash} /></div>
                    </div>
                    <div><div className="text-[#555] text-xs mb-1">Result</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.resultContent} hash={job.resultHash} /></div>
                    </div>
                    {isFinal && (job.reasonContent?.text || job.stateName !== 'CANCELLED') && (
                      <div><div className="text-[#555] text-xs mb-1">Evaluation</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm">
                          <span className={job.stateName === 'COMPLETED' ? 'text-[#4ADE80]' : job.stateName === 'DISPUTED' ? 'text-[#EF4444]' : 'text-[#6B7280]'}>
                            {job.stateName === 'COMPLETED' ? '✓ Approved' : job.stateName === 'DISPUTED' ? '✗ Rejected' : '⛔ Cancelled'}
                          </span>
                          {job.reasonContent?.text && <span className="text-[#ccc]"> — {job.reasonContent.text}</span>}
                          <span className="ml-2 inline-flex items-center"><CopyHash hash={job.descHash} /></span>
                        </div>
                      </div>
                    )}
                  </div>
                </Section>

                {/* Transaction Cards */}
                <Section title="Transactions">
                  <div className="space-y-3">
                    <TxCard color={STATUS_COLORS.OPEN} label="Created" time={fmtDate(job.createdAt)} jobAddr={job.address}>
                      <TxRow label="Client"><ClickAddr addr={job.client} truncate long /></TxRow>
                      <TxRow label="Budget"><BudgetDisplay job={job} /></TxRow>
                      <TxGas />
                    </TxCard>

                    {job.state >= 1 && (
                      <TxCard color={STATUS_COLORS.FUNDED} label="Funded" time={fmtDate(job.createdAt)} jobAddr={job.address}>
                        <TxRow label="Locked"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> in escrow</span></TxRow>
                        <TxGas amount="0.01" />
                      </TxCard>
                    )}

                    {job.submittedAt > 0 && (
                      <TxCard color={STATUS_COLORS.SUBMITTED} label="Submitted" time={fmtDate(job.submittedAt)} jobAddr={job.address}>
                        {job.provider && job.provider !== 'none' && <TxRow label="Provider"><ClickAddr addr={job.provider} truncate long /></TxRow>}
                        {job.resultContent?.text && <TxRow label="Result"><span className="text-[#ccc] text-xs">{job.resultContent.text.slice(0, 80)}{job.resultContent.text.length > 80 ? '...' : ''}</span></TxRow>}
                        <TxGas />
                      </TxCard>
                    )}

                    {job.stateName === 'COMPLETED' && (
                      <TxCard color={STATUS_COLORS.COMPLETED} label="Completed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} jobAddr={job.address}>
                        <TxRow label="Evaluator"><span className="inline-flex items-center gap-1.5"><ClickAddr addr={job.evaluator} truncate long />{job.evaluator === AI_EVALUATOR && <AIBadge addr={AI_EVALUATOR} />}</span></TxRow>
                        <TxRow label="Payout"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> → Provider</span></TxRow>
                        {job.reasonContent?.text && <TxRow label="Reason"><span className="text-[#ccc] text-xs">{job.reasonContent.text}</span></TxRow>}
                        <TxGas amount="0.01" />
                      </TxCard>
                    )}

                    {job.stateName === 'CANCELLED' && (
                      <TxCard color={STATUS_COLORS.CANCELLED} label="Cancelled" jobAddr={job.address}>
                        <TxRow label="Refund"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> → Client</span></TxRow>
                        <TxGas />
                      </TxCard>
                    )}

                    {job.stateName === 'DISPUTED' && (
                      <TxCard color={STATUS_COLORS.DISPUTED} label="Disputed" time={job.submittedAt ? fmtDate(job.submittedAt) : undefined} jobAddr={job.address}>
                        <TxRow label="Evaluator"><ClickAddr addr={job.evaluator} truncate long /></TxRow>
                        <TxRow label="Action">Result rejected, funds refunded</TxRow>
                        <TxGas />
                      </TxCard>
                    )}
                  </div>
                </Section>
              </div>

              <div className="lg:col-span-2 space-y-4">
                <Section title="Participants">
                  <div className="space-y-4">
                    <div><div className="text-[#555] text-xs mb-1">Client</div><ClickAddr addr={job.client} truncate long /></div>
                    <div><div className="text-[#555] text-xs mb-1">Provider</div>
                      {job.provider && job.provider !== 'none' ? <ClickAddr addr={job.provider} truncate long /> : <span className="text-[#555] text-sm">Not assigned</span>}
                    </div>
                    <div><div className="text-[#555] text-xs mb-1">Evaluator</div>
                      <div className="flex items-center gap-2"><ClickAddr addr={job.evaluator} truncate long />{job.evaluator === AI_EVALUATOR && <AIBadge addr={AI_EVALUATOR} />}</div>
                    </div>
                  </div>
                </Section>

                {/* Clean Timeline — single border-left axis */}
                <Section title="Timeline">
                  <div className="relative ml-1.5">
                    {TL_STATES.map((s, i) => {
                      const reached = i <= reachedIdx;
                      const isCurrent = i === reachedIdx;
                      const finalLabel = isCurrent && isFinal && s === 'COMPLETED' ? job.stateName : s;
                      let time = '';
                      if (s === 'OPEN' && job.createdAt) time = fmtDate(job.createdAt);
                      if (s === 'FUNDED' && job.state >= 1 && job.createdAt) time = fmtDate(job.createdAt);
                      if (s === 'SUBMITTED' && job.submittedAt) time = fmtDate(job.submittedAt);
                      if (s === 'COMPLETED' && reached && job.submittedAt) time = fmtDate(job.submittedAt);
                      const isLast = i === TL_STATES.length - 1;

                      return (
                        <div key={s} className="relative flex items-start" style={{ paddingBottom: isLast ? 0 : 24 }}>
                          {/* Vertical line */}
                          {!isLast && (
                            <div className="absolute left-[5px] top-[12px] w-[2px] bottom-0"
                              style={i < reachedIdx ? { backgroundColor: '#4ADE80' } : { borderLeft: '2px dashed #333' }} />
                          )}
                          {/* Dot */}
                          <div className="relative z-10 shrink-0" style={{ width: 12 }}>
                            {isCurrent && reached
                              ? <div className="w-3 h-3 rounded-full border-2 border-[#4ADE80] bg-[#4ADE8040] shadow-[0_0_8px_#4ADE8060]" />
                              : <div className={`w-3 h-3 rounded-full border-2 ${reached ? 'border-[#4ADE80] bg-[#4ADE8040]' : 'border-[#333]'}`} />}
                          </div>
                          {/* Label */}
                          <div className="ml-3">
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
              <button onClick={() => setShowTech(!showTech)} className="flex items-center gap-2 text-xs text-[#555] hover:text-[#888] transition-colors font-mono cursor-pointer">
                <span className={`transform transition-transform ${showTech ? 'rotate-90' : ''}`}>▶</span> Technical Details
              </button>
              {showTech && (
                <div className="mt-3 bg-[#111] border border-[#222] rounded-xl p-5 text-[13px] text-[#555] font-mono space-y-1">
                  {([['jobId', job.jobId], ['state', `${job.state} (${job.stateName})`],
                    ['client', job.client], ['provider', job.provider ?? 'none'], ['evaluator', job.evaluator],
                    ['budget (raw)', job.budget], ['budgetFormatted', job.budgetFormatted],
                    ['descHash', job.descHash], ['resultHash', job.resultHash],
                    ['resultType', (job as any).resultType ?? 0],
                    ['timeout', job.timeout], ['evalTimeout', job.evalTimeout],
                    ['createdAt', job.createdAt], ['submittedAt', job.submittedAt],
                    ['factory', job.type === 'ton' ? FACTORY : JETTON_FACTORY],
                  ] as [string, any][]).map(([k, v]) => (
                    <div key={k} className="flex gap-3"><span className="text-[#444] w-32 shrink-0">{k}</span><span className="text-[#555] break-all">{String(v)}</span></div>
                  ))}
                  <div className="pt-2 mt-2 border-t border-[#1a1a1a] text-[#444] space-y-0.5">
                    <div>Main Cell: jobId · factory · client · provider · state</div>
                    <div>Details: evaluator · budget · descHash · resultHash</div>
                    <div>Extension: timeout · createdAt · evalTimeout · submittedAt · resultType · reason</div>
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

function TxGas({ amount = '0.01' }: { amount?: string }) {
  return <TxRow label="Gas"><span className="inline-flex items-center gap-1">{amount} <TonIcon size={14} /></span></TxRow>;
}
