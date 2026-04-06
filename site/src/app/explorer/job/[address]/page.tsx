'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../../components/Header';
import Footer from '../../../../components/Footer';
import {
  AI_EVALUATOR, FACTORY, JETTON_FACTORY, useExplorerData, buildActivity, STATUS_COLORS, EVENT_DOT_COLORS,
  Badge, Shimmer, TypeIcon, ContentBlock, TonscanLink, ClickAddr, CopyHash,
  BudgetDisplay, fmtDateShort, fmtTimeout, truncAddr, txCount, Job,
} from '../../shared';

/* ── Live countdown timer ── */
function TimeoutCountdown({ createdAt, timeout, isFinal }: { createdAt: number; timeout: number; isFinal: boolean }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (isFinal) return;
    const i = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, [isFinal]);

  const deadline = createdAt + timeout;
  const remaining = Math.max(0, deadline - now);
  const totalH = Math.round(timeout / 3600);

  if (isFinal || remaining === 0) {
    return <span className="text-[#636370] text-sm">Expired ({totalH}h)</span>;
  }

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  return <span className="text-[#A1A1AA] text-sm">{h}h {m}m left ({totalH}h)</span>;
}

export default function JobPage() {
  const { address } = useParams<{ address: string }>();
  const { data, loading } = useExplorerData();

  const job = useMemo(() => {
    if (!data) return null;
    return [...data.tonJobs, ...data.jettonJobs].find(j => j.address === address) ?? null;
  }, [data, address]);

  const isFinal = job ? ['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(job.stateName) : false;
  const wasSubmitted = !!job?.submittedAt;

  // Activity events — from API or fallback from job data
  const jobActivity = useMemo(() => {
    const apiEvents = data?.activity?.filter(a => a.address === address);
    if (apiEvents && apiEvents.length > 0) return apiEvents.sort((a, b) => a.time - b.time);
    // Fallback: build from job data
    if (job) return buildActivity([job]).sort((a, b) => a.time - b.time);
    return [];
  }, [data?.activity, address, job]);

  const numTxns = job ? txCount(job) : 0;

  return (
    <>
      <Header />
      <main className="min-h-screen pt-20 pb-24 px-4 sm:px-6 max-w-[1200px] mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-[#52525B] mb-5">
          <Link href="/explorer" className="hover:text-[#A1A1AA] transition-colors cursor-pointer">← Explorer</Link>
          <span>/</span>
          {job && <span className="text-[#636370]">Job #{job.jobId}</span>}
        </div>

        {loading ? (
          <div className="space-y-4">
            <Shimmer className="h-10 w-96 rounded-lg" />
            <Shimmer className="h-16 rounded-xl" />
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
              <Shimmer className="h-80 rounded-xl" />
              <Shimmer className="h-80 rounded-xl" />
            </div>
          </div>
        ) : !job ? (
          <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-8 text-center">
            <div className="text-[#A1A1AA] text-lg mb-2">Job not found</div>
            <div className="text-[#52525B] text-sm font-mono mb-4 break-all">{address}</div>
            <Link href="/explorer" className="text-[#0098EA] hover:underline text-sm cursor-pointer">← Back to Explorer</Link>
          </div>
        ) : (
          <>
            {/* ── Hero line ── */}
            <div className="flex items-center gap-2.5 mb-6 flex-wrap">
              <TypeIcon type={job.type} size={26} />
              <span className="text-[28px] font-semibold text-white leading-none tracking-tight">#{job.jobId}</span>
              <Badge status={job.stateName} pending={job.pendingState} />
              <span className="text-[#F4F4F5] text-sm font-medium"><BudgetDisplay job={job} /></span>
              <span className="text-[#3F3F46]">·</span>
              <span className="text-[#636370] text-sm">{fmtDateShort(job.createdAt)}</span>
              <span className="text-[#3F3F46]">·</span>
              <span className="inline-flex items-center gap-1 text-sm">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#636370" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <TimeoutCountdown createdAt={job.createdAt} timeout={job.timeout} isFinal={isFinal} />
              </span>
              <span className="text-[#3F3F46]">·</span>
              <span className="text-[#636370] text-sm">{numTxns} txns</span>
            </div>

            {/* ── Info card: single row with 5 columns ── */}
            <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl mb-6 overflow-x-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-[rgba(255,255,255,0.03)]">
                <InfoCol label="Contract"><div className="[&_.break-all]:text-white"><ClickAddr addr={job.address} truncate /></div></InfoCol>
                <InfoCol label="Client"><div className="[&_.break-all]:text-white"><ClickAddr addr={job.client} truncate /></div></InfoCol>
                <InfoCol label="Provider">
                  {job.provider && job.provider !== 'none'
                    ? <div className="[&_.break-all]:text-white"><ClickAddr addr={job.provider} truncate /></div>
                    : <span className="text-[#52525B] text-xs">Not assigned</span>}
                </InfoCol>
                <InfoCol label="Evaluator">
                  {job.evaluator === AI_EVALUATOR
                    ? <span className="inline-flex items-center gap-1.5"><CopyableAddr addr={AI_EVALUATOR} label="AI Evaluator" /><TonscanLink addr={AI_EVALUATOR} size={12} /></span>
                    : <div className="[&_.break-all]:text-white"><ClickAddr addr={job.evaluator} truncate /></div>}
                </InfoCol>
                <InfoCol label="Factory">
                  <Link href={`/explorer/factory/${job.type === 'ton' ? FACTORY : JETTON_FACTORY}`} className="text-[#0098EA] text-xs hover:underline">{job.type === 'ton' ? 'JobFactory' : 'JettonJobFactory'}</Link>
                </InfoCol>
              </div>
            </div>

            {/* ── Two columns: Timeline (left) + Content (right) ── */}
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 mb-6">
              {/* Timeline */}
              <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
                <div className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider mb-4">Timeline</div>
                <div className="relative ml-1">
                  {jobActivity.map((ev, i) => {
                    const isLast = i === jobActivity.length - 1;
                    const color = EVENT_DOT_COLORS[ev.event] || STATUS_COLORS[ev.status] || '#555';
                    return (
                      <div key={`${ev.event}-${ev.time}-${i}`} className="relative flex items-start" style={{ paddingBottom: isLast ? 0 : 28 }}>
                        {/* Line */}
                        {!isLast && (
                          <div className="absolute left-[3.5px] top-[12px] w-[1px] bottom-0 bg-[rgba(255,255,255,0.1)]" />
                        )}
                        {/* Dot */}
                        <div className="relative z-10 shrink-0 mt-[3px]" style={{ width: 8 }}>
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                        </div>
                        {/* Event info */}
                        <div className="ml-3 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium" style={{ color }}>{ev.event}</span>
                            <a href={ev.txHash ? `https://tonscan.org/tx/${ev.txHash}` : `https://tonscan.org/address/${job.address}`}
                              target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                              className="text-[#52525B] hover:text-white transition-colors cursor-pointer shrink-0" title={ev.txHash ? 'View transaction' : 'View contract'}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path fill="currentColor" d="M4.14 6.881c0 .199.483.684.84.676.358-.007.88-.452.88-.676 0-.223-.523-.257-.839-.257s-.88.059-.88.257M2.677 5.679c.517.201 1.04.09 1.168-.247s-.189-.774-.706-.976-.958-.225-1.086.113c-.127.337.107.908.624 1.11M6.158 5.432c.128.338.66.425 1.15.188.488-.236.717-.713.59-1.051-.128-.338-.517-.315-1.035-.113s-.833.639-.705.976"/><path fill="currentColor" fillRule="evenodd" d="M1.814.343c.435.267.995.698 1.677 1.284Q4.4 1.469 5 1.468q.597.001 1.494.159C7.18 1.053 7.742.628 8.175.362c.227-.14.437-.247.62-.304.163-.05.414-.097.626.05a.7.7 0 0 1 .249.35q.066.19.093.443c.037.336.035.801-.012 1.414q-.045.581-.157 1.22c.404.768.503 1.627.314 2.557-.186.912-.784 1.726-1.672 2.468C7.368 9.285 6.292 10 4.99 10c-1.29 0-2.57-.733-3.338-1.454C.9 7.84.395 7.143.16 6.342-.114 5.416-.033 4.48.386 3.55q-.121-.67-.156-1.24C.188 1.59.177 1.13.21.824.225.67.254.531.31.411A.75.75 0 0 1 .544.118c.209-.16.462-.127.637-.077.19.054.403.16.633.302M.982.738.96.732A1 1 0 0 0 .93.9c-.025.237-.02.64.024 1.368q.032.56.165 1.262l.022.116-.051.107C.697 4.574.626 5.363.854 6.138c.186.632.595 1.222 1.295 1.88.686.644 1.798 1.257 2.842 1.257 1.033 0 1.938-.567 2.78-1.27.82-.687 1.286-1.368 1.426-2.057.169-.829.063-1.545-.297-2.171l-.066-.116.024-.131q.125-.675.17-1.27c.046-.594.044-1.009.014-1.28a1.5 1.5 0 0 0-.039-.227c-.1.032-.247.103-.45.227-.412.253-.984.686-1.721 1.31L6.7 2.4l-.169-.03C5.88 2.25 5.372 2.193 5 2.193q-.555-.001-1.552.177l-.17.03-.132-.113C2.414 1.65 1.846 1.212 1.435.96A2 2 0 0 0 .982.738" clipRule="evenodd"/></svg>
                            </a>
                          </div>
                          <div className="text-[#52525B] text-xs mt-0.5">{fmtDateShort(ev.time)}</div>
                          {ev.from && (
                            <div className="mt-1 text-xs">
                              <CopyableAddr addr={ev.from} label={ev.from === AI_EVALUATOR ? 'AI Evaluator' : undefined} />
                            </div>
                          )}
                          {ev.event === 'Created' && !ev.from && (
                            <div className="mt-1 text-xs">
                              <CopyableAddr addr={job.client} />
                            </div>
                          )}
                          {ev.event === 'Funded' && (
                            <div className="mt-0.5 text-xs text-white"><BudgetDisplay job={job} /> <span className="text-white">locked</span></div>
                          )}
                          {ev.event === 'Approved' && (
                            <div className="mt-0.5 text-xs text-white"><BudgetDisplay job={job} /> <span className="text-white">→ Provider</span></div>
                          )}
                          {ev.event === 'Cancelled' && (
                            <div className="mt-0.5 text-xs text-white"><BudgetDisplay job={job} /> <span className="text-white">→ Client</span></div>
                          )}
                          {ev.event === 'Claimed' && (
                            <div className="mt-0.5 text-xs text-white"><BudgetDisplay job={job} /> <span className="text-white">→ Provider</span></div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {jobActivity.length === 0 && (
                    <div className="text-[#52525B] text-xs">No events yet</div>
                  )}
                </div>
              </div>

              {/* Content column */}
              <div className="space-y-4">
                {/* Description card */}
                <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
                  <div className="mb-3">
                    <span className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider">Description</span>
                  </div>
                  <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.03)] rounded-[10px] p-4">
                    <ContentBlock content={job.description} hash={job.descHash} />
                  </div>
                </div>

                {/* Result card */}
                {wasSubmitted && (
                  <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider">Result</span>
                      {job.resultContent?.encrypted && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-[#A78BFA] bg-[rgba(167,139,250,0.1)] border border-[rgba(167,139,250,0.2)] px-1.5 py-0.5 rounded">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                          E2E Encrypted
                        </span>
                      )}
                    </div>
                    <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.03)] rounded-[10px] p-4">
                      {job.resultContent?.encrypted ? (
                        <p className="text-[#A78BFA] text-sm italic">This result is end-to-end encrypted. Only the job client and evaluator can decrypt it.</p>
                      ) : (
                        <ContentBlock content={job.resultContent} hash={job.resultHash} />
                      )}
                    </div>
                  </div>
                )}

                {/* Evaluation card */}
                {(job.stateName === 'COMPLETED' || job.stateName === 'DISPUTED') && (
                  <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
                    <div className="mb-3">
                      <span className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider">Evaluation</span>
                    </div>
                    <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.03)] rounded-[10px] p-4">
                      <div className="flex items-center gap-2 mb-2">
                        {job.stateName === 'COMPLETED' ? (
                          <>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#22C55E" strokeWidth="1.5"/><path d="M8 12.5l2.5 2.5 5-5" stroke="#22C55E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            <span className="text-[#22C55E] text-sm font-medium">Approved</span>
                          </>
                        ) : (
                          <>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#EF4444" strokeWidth="1.5"/><path d="M15 9l-6 6M9 9l6 6" stroke="#EF4444" strokeWidth="1.5" strokeLinecap="round"/></svg>
                            <span className="text-[#EF4444] text-sm font-medium">Rejected</span>
                          </>
                        )}
                      </div>
                      {job.reasonContent?.text ? (
                        <div>
                          <p className="text-[#A1A1AA] text-sm leading-relaxed whitespace-pre-wrap">{job.reasonContent.text}</p>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="flex-1" />
                            {job.reasonContent.source === 'ipfs' && job.reasonContent.ipfsUrl && (
                              <a href={job.reasonContent.ipfsUrl} target="_blank" rel="noopener noreferrer" className="text-[#52525B] hover:text-white transition-colors cursor-pointer inline-flex items-center" title="View on IPFS">
                                <img src="/logos/pinata.jpeg" alt="IPFS" width={14} height={14} className="rounded-sm align-middle" />
                              </a>
                            )}
                            <CopyHash hash={job.reasonHash || (job.reasonContent.source === 'hex' ? Array.from(new TextEncoder().encode(job.reasonContent.text!)).map(b => b.toString(16).padStart(2, '0')).join('') : job.reasonContent.text!)} />
                          </div>
                        </div>
                      ) : job.reasonHash && job.reasonHash !== '0'.repeat(64) ? (
                        <p className="text-[#52525B] text-sm italic">Loading from IPFS...</p>
                      ) : (
                        <p className="text-[#52525B] text-sm">No reason provided</p>
                      )}
                    </div>
                  </div>
                )}

                {job.stateName === 'CANCELLED' && (
                  <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
                    <div className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider mb-3">Status</div>
                    <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.03)] rounded-[10px] p-4">
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#6B7280" strokeWidth="1.5"/><path d="M4.93 4.93l14.14 14.14" stroke="#6B7280" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        <span className="text-[#6B7280] text-sm font-medium">Cancelled — funds refunded to client</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Technical Details: collapsible ── */}
            <TechnicalDetails job={job} />
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

/* ── Helper components ── */

function InfoCol({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5">
      <div className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider mb-1.5">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function TechCol({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2">
      <div className="text-[#3F3F46] text-[10px] font-mono uppercase tracking-wider mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function TechnicalDetails({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const zeroHash = '0'.repeat(64);
  return (
    <div className="bg-[rgba(255,255,255,0.02)] border border-[rgba(255,255,255,0.06)] rounded-xl">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3.5 cursor-pointer">
        <span className="text-[#52525B] text-[10px] font-mono uppercase tracking-wider">Technical Details</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#52525B" strokeWidth="1.5" strokeLinecap="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
          <path d="M3 4.5L6 7.5L9 4.5"/>
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-4 border-t border-[rgba(255,255,255,0.03)] pt-3 space-y-4">
          {/* On-Chain Data */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">On-Chain</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Job Contract" value={job.address} copy mono />
              <TechRow label="Factory" value={job.type === 'usdt' ? 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB…' : 'EQAFHodWCzrYJTbrbJp1lMDQLfyp…'} />
              <TechRow label="State (int)" value={`${job.state} (${job.stateName})`} />
              <TechRow label="Job ID" value={`${job.jobId}`} />
              <TechRow label="Type" value={job.type.toUpperCase()} />
              <TechRow label="Budget (nanoton)" value={job.budget} mono />
            </div>
          </div>

          {/* Participants */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">Participants</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Client" value={job.client} copy mono />
              <TechRow label="Provider" value={job.provider || '—'} copy={!!job.provider} mono />
              <TechRow label="Evaluator" value={job.evaluator} copy mono />
            </div>
          </div>

          {/* Hashes */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">Content Hashes (SHA-256, on-chain)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Description Hash" value={job.descHash || '—'} copy={!!job.descHash} mono />
              <TechRow label="Result Hash" value={job.resultHash && job.resultHash !== zeroHash ? job.resultHash : '—'} copy={!!job.resultHash && job.resultHash !== zeroHash} mono />
              {(job as any).reasonHash && (job as any).reasonHash !== zeroHash && (
                <TechRow label="Reason Hash" value={(job as any).reasonHash} copy mono />
              )}
            </div>
          </div>

          {/* IPFS Sources */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">Content Sources</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Description" value={job.description?.source || 'hash'} />
              {job.description?.ipfsUrl && <TechRow label="Desc IPFS URL" value={job.description.ipfsUrl} copy full />}
              {job.resultContent?.source && job.resultHash && job.resultHash !== zeroHash && (
                <TechRow label="Result" value={job.resultContent.source} />
              )}
              {job.resultContent?.ipfsUrl && <TechRow label="Result IPFS URL" value={job.resultContent.ipfsUrl} copy full />}
              {job.reasonContent?.source && job.reasonContent.source !== 'hash' && (
                <TechRow label="Reason" value={job.reasonContent.source} />
              )}
              {job.description?.file && <TechRow label="Desc File" value={`${job.description.file.filename} (${job.description.file.mimeType})`} />}
              {job.resultContent?.file && <TechRow label="Result File" value={`${job.resultContent.file.filename} (${job.resultContent.file.mimeType})`} />}
            </div>
          </div>

          {/* Timing */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">Timing</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Created At" value={job.createdAt ? `${job.createdAt} (${new Date(job.createdAt * 1000).toISOString()})` : '—'} />
              {job.submittedAt > 0 && <TechRow label="Submitted At" value={`${job.submittedAt} (${new Date(job.submittedAt * 1000).toISOString()})`} />}
              <TechRow label="Timeout" value={`${job.timeout}s (${Math.round(job.timeout / 3600)}h)`} />
              <TechRow label="Eval Timeout" value={`${job.evalTimeout}s (${Math.round(job.evalTimeout / 3600)}h)`} />
              {job.createdAt > 0 && <TechRow label="Deadline" value={new Date((job.createdAt + job.timeout) * 1000).toISOString()} />}
              {job.submittedAt > 0 && <TechRow label="Eval Deadline" value={new Date((job.submittedAt + job.evalTimeout) * 1000).toISOString()} />}
            </div>
          </div>

          {/* Transactions */}
          <div>
            <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-2 font-medium">Transactions ({job.transactions?.length || txCount(job)})</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <TechRow label="Tx Count" value={String(job.transactions?.length || txCount(job))} />
              {job.resultType != null && <TechRow label="Result Type" value={String(job.resultType)} />}
              <TechRow label="Has File Attachment" value={job.hasFile ? 'Yes' : 'No'} />
              {job.pendingState && <TechRow label="Pending State" value={job.pendingState} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TechRow({ label, value, copy, mono, full }: { label: string; value: string; copy?: boolean; mono?: boolean; full?: boolean }) {
  const display = full ? value : value.length > 50 ? value.slice(0, 24) + '…' + value.slice(-8) : value;
  const isUrl = value.startsWith('http');
  return (
    <div className={`min-w-0 ${full ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <div className="text-[#3F3F46] text-[9px] uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`text-[11px] text-[#71717A] ${mono ? 'font-mono' : ''} break-all inline-flex items-center gap-1`}>
        {isUrl ? <a href={value} target="_blank" rel="noopener noreferrer" className="hover:text-[#A1A1AA] underline underline-offset-2">{display}</a> : <span>{display}</span>}
        {copy && value !== '—' && <CopyHash hash={value} />}
      </div>
    </div>
  );
}

function CopyableAddr({ addr, label }: { addr: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`font-mono text-xs cursor-pointer transition-colors ${copied ? 'text-[#22C55E]' : 'text-white hover:text-[#A1A1AA]'}`}
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? 'Copied!' : (label || truncAddr(addr))}
    </span>
  );
}

function IpfsLabel({ hash, url }: { hash: string; url: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-[#52525B] hover:text-[#A1A1AA] transition-colors cursor-pointer font-mono">
        IPFS
        <span className="text-[#3F3F46]">{hash.slice(0, 8)}...</span>
      </a>
      <CopyHash hash={hash} />
    </span>
  );
}
