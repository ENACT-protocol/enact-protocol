'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, Job, useExplorerData, STATUS_COLORS,
  Badge, Shimmer, TypeIcon, ClickAddr, Row, ContentBlock, TonscanLink, AIBadge, CopyHash,
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

  const isFinal = job ? ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(job.stateName) : false;
  const wasSubmitted = !!job?.submittedAt;

  // Txs: newest-first from API → reverse to chronological
  const txsRev = useMemo(() => [...(job?.transactions ?? [])].reverse(), [job]);
  const isUsdt = job?.type === 'usdt';

  // Last tx is always the terminal action (cancel/evaluate)
  const lastTx = txsRev.length > 0 ? txsRev[txsRev.length - 1] : null;

  // Index mapping: take and submit are separate txs
  const hasTaken = !!(job?.provider && job.provider !== 'none');
  const baseOffset = isUsdt ? 3 : 2;
  const submitOffset = hasTaken ? baseOffset + 1 : baseOffset;
  const terminalOffset = job?.submittedAt ? submitOffset + 1 : baseOffset + 1;
  const txIdx = {
    created: 0,
    setWallet: isUsdt ? 1 : -1,
    funded: isUsdt ? 2 : 1,
    taken: baseOffset,
    submitted: submitOffset,
    terminal: terminalOffset,
  };
  const txAt = (idx: number) => idx >= 0 && idx < txsRev.length ? txsRev[idx] : null;

  // Timeline: compute which states were reached
  const tlStates = useMemo(() => {
    if (!job) return [];
    const states: Array<{ name: string; reached: boolean; current: boolean; time: string; color: string }> = [];
    const addState = (name: string, reached: boolean, current: boolean, time: number) => {
      states.push({ name, reached, current, time: reached && time ? fmtDate(time) : '', color: STATUS_COLORS[name] || '#555' });
    };

    const createTime = txAt(0)?.utime || job.createdAt || 0;
    const fundTime = txAt(txIdx.funded)?.utime || job.createdAt || 0;
    const submitTime = txAt(txIdx.submitted)?.utime || job.submittedAt || 0;

    addState('OPEN', true, job.stateName === 'OPEN', createTime);

    const hasTaken = !!(job.provider && job.provider !== 'none');
    const takenTime = submitTime ? submitTime - 1 : fundTime + 1;

    if (job.stateName === 'CANCELLED' && !wasSubmitted) {
      addState('FUNDED', job.state >= 1 || job.stateName === 'CANCELLED', false, fundTime);
      addState('CANCELLED', true, true, lastTx?.utime || 0);
    } else if (job.stateName === 'CANCELLED' && wasSubmitted) {
      addState('FUNDED', true, false, fundTime);
      if (hasTaken) addState('TAKEN', true, false, takenTime);
      addState('SUBMITTED', true, false, submitTime);
      addState('CANCELLED', true, true, lastTx?.utime || 0);
    } else if (job.stateName === 'DISPUTED') {
      addState('FUNDED', true, false, fundTime);
      if (hasTaken) addState('TAKEN', true, false, takenTime);
      addState('SUBMITTED', true, false, submitTime);
      addState('DISPUTED', true, true, lastTx?.utime || 0);
    } else {
      // Normal flow: OPEN → FUNDED → [TAKEN] → SUBMITTED → COMPLETED
      addState('FUNDED', job.state >= 1, job.stateName === 'FUNDED', fundTime);
      if (hasTaken) addState('TAKEN', hasTaken, false, takenTime);
      addState('SUBMITTED', !!job.submittedAt, job.stateName === 'SUBMITTED', submitTime);
      const completedTime = txAt(txIdx.terminal)?.utime || (job.submittedAt ? job.submittedAt + 1 : 0);
      addState('COMPLETED', job.stateName === 'COMPLETED', job.stateName === 'COMPLETED', completedTime);
    }
    return states;
  }, [job, txsRev]);

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
                    <Row label="Created">{fmtDate(txAt(0)?.utime || job.createdAt)}</Row>
                    <Row label="Timeout">{fmtTimeout(job.timeout)} (eval: {fmtTimeout(job.evalTimeout)})</Row>
                  </div>
                </Section>

                <Section title="Content">
                  <div className="space-y-4">
                    <div><div className="text-[#555] text-xs mb-1">Description</div>
                      <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.description} hash={job.descHash} /></div>
                    </div>
                    {wasSubmitted && (
                      <div><div className="text-[#555] text-xs mb-1">Result</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3"><ContentBlock content={job.resultContent} hash={job.resultHash} /></div>
                      </div>
                    )}
                    {job.stateName === 'COMPLETED' && (
                      <div><div className="text-[#555] text-xs mb-1">Evaluation</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm inline-flex items-center gap-2">
                          <span className="text-[#4ADE80] inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg> Approved</span>
                          {job.reasonContent?.text && <span className="text-[#ccc]">— {job.reasonContent.text}</span>}
                        </div>
                      </div>
                    )}
                    {job.stateName === 'DISPUTED' && (
                      <div><div className="text-[#555] text-xs mb-1">Evaluation</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm inline-flex items-center gap-2">
                          <span className="text-[#EF4444] inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Rejected</span>
                          {job.reasonContent?.text && <span className="text-[#ccc]">— {job.reasonContent.text}</span>}
                        </div>
                      </div>
                    )}
                    {job.stateName === 'CANCELLED' && (
                      <div><div className="text-[#555] text-xs mb-1">Status</div>
                        <div className="bg-[#0a0a0a] rounded-lg p-3 text-sm">
                          <span className="text-[#6B7280] inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg> Cancelled — funds refunded to client</span>
                        </div>
                      </div>
                    )}
                  </div>
                </Section>

                {/* Transaction Cards */}
                <Section title="Transactions">
                  <div className="space-y-3">
                    {(() => {
                      const isAI = job.evaluator === AI_EVALUATOR;
                      const createTx = txAt(txIdx.created);
                      const fundTx = txAt(txIdx.funded);
                      const walletTx = txAt(txIdx.setWallet);

                      return <>
                        <TxCard color={STATUS_COLORS.OPEN} label="Created" time={fmtDate(createTx?.utime || job.createdAt)} txHash={createTx?.hash ?? ''}>
                          <TxRow label="Client"><ClickAddr addr={job.client} truncate /></TxRow>
                          <TxRow label="Budget"><BudgetDisplay job={job} /></TxRow>
                        </TxCard>

                        {job.type === 'usdt' && (job.state >= 1 || job.stateName === 'CANCELLED') && (
                          <TxCard color="#888" label="Set Jetton Wallet" time={fmtDate(walletTx?.utime || job.createdAt)} txHash={walletTx?.hash ?? ''}>
                            <TxRow label="Action">USDT wallet configured</TxRow>
                          </TxCard>
                        )}

                        {(job.state >= 1 || job.stateName === 'CANCELLED') && (
                          <TxCard color={STATUS_COLORS.FUNDED} label="Funded" time={fmtDate(fundTx?.utime || job.createdAt)} txHash={fundTx?.hash ?? ''}>
                            <TxRow label="Locked"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> in escrow</span></TxRow>
                          </TxCard>
                        )}

                        {job.provider && job.provider !== 'none' && (() => {
                          const takeTx = txAt(txIdx.taken) || txsRev[txsRev.length - 1];
                          return (
                            <TxCard color={STATUS_COLORS.TAKEN || '#38BDF8'} label="Taken" time={fmtDate(takeTx?.utime || job.createdAt)} txHash={takeTx?.hash ?? ''}>
                              <TxRow label="Provider"><ClickAddr addr={job.provider!} truncate /></TxRow>
                            </TxCard>
                          );
                        })()}

                        {wasSubmitted && (() => {
                          const submitTx = txAt(txIdx.submitted);
                          return (
                            <TxCard color={STATUS_COLORS.SUBMITTED} label="Submitted" time={fmtDate(submitTx?.utime || job.submittedAt)} txHash={submitTx?.hash ?? ''}>
                              {job.provider && job.provider !== 'none' && <TxRow label="Provider"><ClickAddr addr={job.provider} truncate /></TxRow>}
                              <TxRow label="Result">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="text-[#ccc] text-xs">{job.resultContent?.text ? (job.resultContent.text.slice(0, 80) + (job.resultContent.text.length > 80 ? '...' : '')) : '—'}</span>
                                  {job.resultContent?.ipfsUrl && <a href={job.resultContent.ipfsUrl} target="_blank" rel="noopener noreferrer" className="text-[#555] hover:text-white transition-colors cursor-pointer inline-flex items-center" title="View on IPFS"><img src="/logos/pinata.jpeg" alt="IPFS" width={12} height={12} className="rounded-sm" /></a>}
                                  <CopyHash hash={job.resultHash} />
                                </span>
                              </TxRow>
                            </TxCard>
                          );
                        })()}

                        {job.stateName === 'COMPLETED' && (
                          <TxCard color={STATUS_COLORS.COMPLETED} label="Approved" time={fmtDate(lastTx?.utime || job.submittedAt)} txHash={lastTx?.hash ?? ''}>
                            <TxRow label="Evaluator">{isAI ? <AIBadge addr={AI_EVALUATOR} /> : <ClickAddr addr={job.evaluator} truncate />}</TxRow>
                            <TxRow label="Payout"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> → Provider</span></TxRow>
                            {job.reasonContent?.text && <TxRow label="Reason"><span className="text-[#ccc] text-xs">{job.reasonContent.text}</span></TxRow>}
                          </TxCard>
                        )}

                        {job.stateName === 'CANCELLED' && (
                          <TxCard color={STATUS_COLORS.CANCELLED} label="Cancelled" time={fmtDate(lastTx?.utime || 0)} txHash={lastTx?.hash ?? ''}>
                            <TxRow label="Client"><ClickAddr addr={job.client} truncate /></TxRow>
                            <TxRow label="Refund"><span className="inline-flex items-center gap-1"><BudgetDisplay job={job} /> → Client</span></TxRow>
                          </TxCard>
                        )}

                        {job.stateName === 'DISPUTED' && (
                          <TxCard color={STATUS_COLORS.DISPUTED} label="Rejected" time={fmtDate(lastTx?.utime || job.submittedAt)} txHash={lastTx?.hash ?? ''}>
                            <TxRow label="Evaluator">{isAI ? <AIBadge addr={AI_EVALUATOR} /> : <ClickAddr addr={job.evaluator} truncate />}</TxRow>
                            <TxRow label="Action">Result rejected, funds refunded</TxRow>
                          </TxCard>
                        )}
                      </>;
                    })()}
                  </div>
                </Section>
              </div>

              <div className="lg:col-span-2 space-y-4">
                <Section title="Participants">
                  <div className="space-y-4">
                    <div><div className="text-[#555] text-xs mb-1">Client</div><ClickAddr addr={job.client} truncate /></div>
                    <div><div className="text-[#555] text-xs mb-1">Provider</div>
                      {job.provider && job.provider !== 'none' ? <ClickAddr addr={job.provider} truncate /> : <span className="text-[#555] text-sm">Not assigned</span>}
                    </div>
                    <div><div className="text-[#555] text-xs mb-1">Evaluator</div>
                      {job.evaluator === AI_EVALUATOR ? <AIBadge addr={AI_EVALUATOR} /> : <ClickAddr addr={job.evaluator} truncate />}
                    </div>
                  </div>
                </Section>

                {/* Timeline */}
                <Section title="Timeline">
                  <div className="relative ml-1.5">
                    {tlStates.map((s, i) => {
                      const isLast = i === tlStates.length - 1;
                      return (
                        <div key={s.name} className="relative flex items-start" style={{ paddingBottom: isLast ? 0 : 24 }}>
                          {!isLast && (
                            <div className="absolute left-[5px] top-[12px] w-[2px] bottom-0"
                              style={s.reached ? { backgroundColor: s.color } : { borderLeft: '2px dashed #333' }} />
                          )}
                          <div className="relative z-10 shrink-0" style={{ width: 12 }}>
                            {s.current
                              ? <div className="w-3 h-3 rounded-full border-2" style={{ borderColor: s.color, backgroundColor: s.color + '40', boxShadow: `0 0 8px ${s.color}60` }} />
                              : <div className={`w-3 h-3 rounded-full border-2 ${s.reached ? '' : 'border-[#333]'}`} style={s.reached ? { borderColor: s.color, backgroundColor: s.color + '40' } : {}} />}
                          </div>
                          <div className="ml-3">
                            <div className={`text-sm ${s.reached ? 'text-white' : 'text-[#555]'}`}>{s.name}</div>
                            {s.time && <div className="text-[#555] text-xs">{s.time}</div>}
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
                    ['resultType', job.resultType ?? 0],
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
  return <div className="bg-[#111] border border-[#222] rounded-xl p-5 explorer-section"><div className="text-[#555] text-xs font-mono mb-4 uppercase tracking-wider">{title}</div>{children}</div>;
}

function TxCard({ color, label, time, txHash, children }: { color: string; label: string; time?: string; txHash?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-4 bg-[#0a0a0a] explorer-tx" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span style={{ color }} className="text-lg leading-none">●</span>
          <span className="text-white text-sm font-medium">{label}</span>
        </div>
        {txHash && (
          <a href={`https://tonscan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-[#555] hover:text-white transition-colors cursor-pointer inline-flex items-center" title="View transaction">
            <svg width="16" height="16" viewBox="0 0 10 10" fill="none"><path fill="currentColor" d="M4.14 6.881c0 .199.483.684.84.676.358-.007.88-.452.88-.676 0-.223-.523-.257-.839-.257s-.88.059-.88.257M2.677 5.679c.517.201 1.04.09 1.168-.247s-.189-.774-.706-.976-.958-.225-1.086.113c-.127.337.107.908.624 1.11M6.158 5.432c.128.338.66.425 1.15.188.488-.236.717-.713.59-1.051-.128-.338-.517-.315-1.035-.113s-.833.639-.705.976"/><path fill="currentColor" fillRule="evenodd" d="M1.814.343c.435.267.995.698 1.677 1.284Q4.4 1.469 5 1.468q.597.001 1.494.159C7.18 1.053 7.742.628 8.175.362c.227-.14.437-.247.62-.304.163-.05.414-.097.626.05a.7.7 0 0 1 .249.35q.066.19.093.443c.037.336.035.801-.012 1.414q-.045.581-.157 1.22c.404.768.503 1.627.314 2.557-.186.912-.784 1.726-1.672 2.468C7.368 9.285 6.292 10 4.99 10c-1.29 0-2.57-.733-3.338-1.454C.9 7.84.395 7.143.16 6.342-.114 5.416-.033 4.48.386 3.55q-.121-.67-.156-1.24C.188 1.59.177 1.13.21.824.225.67.254.531.31.411A.75.75 0 0 1 .544.118c.209-.16.462-.127.637-.077.19.054.403.16.633.302M.982.738.96.732A1 1 0 0 0 .93.9c-.025.237-.02.64.024 1.368q.032.56.165 1.262l.022.116-.051.107C.697 4.574.626 5.363.854 6.138c.186.632.595 1.222 1.295 1.88.686.644 1.798 1.257 2.842 1.257 1.033 0 1.938-.567 2.78-1.27.82-.687 1.286-1.368 1.426-2.057.169-.829.063-1.545-.297-2.171l-.066-.116.024-.131q.125-.675.17-1.27c.046-.594.044-1.009.014-1.28a1.5 1.5 0 0 0-.039-.227c-.1.032-.247.103-.45.227-.412.253-.984.686-1.721 1.31L6.7 2.4l-.169-.03C5.88 2.25 5.372 2.193 5 2.193q-.555-.001-1.552.177l-.17.03-.132-.113C2.414 1.65 1.846 1.212 1.435.96A2 2 0 0 0 .982.738" clipRule="evenodd"/></svg>
          </a>
        )}
      </div>
      {time && <div className="text-[#555] text-xs mb-2">{time}</div>}
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TxRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2 text-sm"><span className="text-[#555] w-20 shrink-0">{label}</span><span className="text-[#ccc] min-w-0">{children}</span></div>;
}
