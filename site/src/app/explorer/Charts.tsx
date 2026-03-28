'use client';

import { useState, useEffect, useMemo } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Job } from './shared';

interface DayStat { day: string; factory_type: string; job_count: number; volume: number; }

const VolumeTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0A0A0E', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '6px 10px', fontSize: 11 }}>
      <div style={{ color: '#666', marginBottom: 3 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          {p.name}: {Number(p.value).toFixed(2)}
        </div>
      ))}
    </div>
  );
};

const JobsTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0A0A0E', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '6px 10px', fontSize: 11 }}>
      <div style={{ color: '#666', marginBottom: 3 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          {p.name}: {Math.round(p.value)}
        </div>
      ))}
    </div>
  );
};

function buildChartData(stats: DayStat[]) {
  const dayMap = new Map<string, { day: string; tonJobs: number; usdtJobs: number; tonVol: number; usdtVol: number }>();
  for (const s of stats) {
    const entry = dayMap.get(s.day) || { day: s.day, tonJobs: 0, usdtJobs: 0, tonVol: 0, usdtVol: 0 };
    if (s.factory_type === 'ton') { entry.tonJobs += Number(s.job_count); entry.tonVol += Number(s.volume) / 1e9; }
    else { entry.usdtJobs += Number(s.job_count); entry.usdtVol += Number(s.volume) / 1e6; }
    dayMap.set(s.day, entry);
  }
  return Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export function ExplorerCharts() {
  const [stats, setStats] = useState<DayStat[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/api/explorer/stats').then(r => r.json()).then(d => { if (Array.isArray(d)) setStats(d); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="h-[250px] bg-[#ffffff05] border border-[#ffffff0f] rounded-xl animate-pulse" />;
  if (!stats.length) return null;
  return <ChartPair data={buildChartData(stats)} showBoth />;
}

export function FactoryCharts({ jobs, type }: { jobs: Job[]; type: 'ton' | 'usdt' }) {
  const chartData = useMemo(() => {
    const dayMap = new Map<string, { day: string; jobs: number; vol: number }>();
    for (const j of jobs) {
      if (!j.createdAt) continue;
      const day = new Date(j.createdAt * 1000).toISOString().slice(0, 10);
      const entry = dayMap.get(day) || { day, jobs: 0, vol: 0 };
      entry.jobs++;
      entry.vol += type === 'usdt' ? Number(BigInt(j.budget)) / 1e6 : Number(BigInt(j.budget)) / 1e9;
      dayMap.set(day, entry);
    }
    return Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [jobs, type]);

  if (!chartData.length) return null;
  let cum = 0;
  const volumeData = chartData.map(d => { cum += d.vol; return { day: d.day.slice(5), vol: +cum.toFixed(2) }; });
  const barData = chartData.map(d => ({ day: d.day.slice(5), jobs: d.jobs }));
  const color = type === 'ton' ? '#0088CC' : '#26A17B';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <ChartCard title={`Volume (${type === 'ton' ? 'TON' : 'USDT'})`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={volumeData} margin={{ top: 36, right: 32, bottom: 0, left: 0 }}>
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} tickMargin={2} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} width={24} tickMargin={2} />
            <Tooltip content={<VolumeTooltip />} cursor={{ stroke: '#333', strokeWidth: 1 }} />
            <Area type="monotone" dataKey="vol" name={type.toUpperCase()} stroke={color} fill={color} fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 3, fill: color, stroke: '#050508', strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Jobs Per Day">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} margin={{ top: 36, right: 32, bottom: 0, left: 0 }} barCategoryGap="20%">
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} tickMargin={2} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} width={18} tickMargin={2} allowDecimals={false} />
            <Tooltip content={<JobsTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="jobs" name="Jobs" fill={color} fillOpacity={0.85} radius={[3, 3, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function ChartPair({ data, showBoth }: { data: ReturnType<typeof buildChartData>; showBoth?: boolean }) {
  let cumTon = 0, cumUsdt = 0;
  const volumeData = data.map(d => {
    cumTon += d.tonVol; cumUsdt += d.usdtVol;
    return { day: d.day.slice(5), tonVol: +cumTon.toFixed(2), usdtVol: +cumUsdt.toFixed(2) };
  });
  const barData = data.map(d => ({ day: d.day.slice(5), ton: d.tonJobs, usdt: d.usdtJobs }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <ChartCard title="Cumulative Volume">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={volumeData} margin={{ top: 36, right: 32, bottom: 0, left: 0 }}>
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} tickMargin={2} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} width={24} tickMargin={2} />
            <Tooltip content={<VolumeTooltip />} cursor={{ stroke: '#333', strokeWidth: 1 }} />
            <Area type="monotone" dataKey="tonVol" name="TON" stroke="#0088CC" fill="#0088CC" fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#0088CC', stroke: '#050508', strokeWidth: 2 }} />
            {showBoth && <Area type="monotone" dataKey="usdtVol" name="USDT" stroke="#26A17B" fill="#26A17B" fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#26A17B', stroke: '#050508', strokeWidth: 2 }} />}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Jobs Per Day">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} margin={{ top: 36, right: 32, bottom: 0, left: 0 }} barCategoryGap="20%">
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} tickMargin={2} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#52525B' }} axisLine={false} tickLine={false} width={18} tickMargin={2} allowDecimals={false} />
            <Tooltip content={<JobsTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="ton" name="TON" fill="#0088CC" fillOpacity={0.85} radius={[3, 3, 0, 0]} maxBarSize={40} />
            {showBoth && <Bar dataKey="usdt" name="USDT" fill="#26A17B" fillOpacity={0.85} radius={[3, 3, 0, 0]} maxBarSize={40} />}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#ffffff05] border border-[#ffffff0f] rounded-xl relative h-[250px] overflow-hidden">
      <div className="absolute top-0 left-0 z-10 text-[#52525B] text-[10px] font-mono uppercase tracking-wider bg-[rgba(5,5,8,0.8)] px-3 py-1.5 rounded-br-lg">{title}</div>
      {children}
    </div>
  );
}

type SparkMeta = { label?: string; days?: string[]; details?: { label: string; data: number[] }[] };

function SparkTip({ active, payload, meta }: { active?: boolean; payload?: any[]; meta?: SparkMeta }) {
  if (!active || !payload?.length) return null;
  const idx = payload[0]?.payload?.i;
  const day = meta?.days?.[idx];
  const val = Number(payload[0].value);
  return (
    <div style={{
      background: '#0A0A0E', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
      padding: '6px 10px', fontSize: 11, color: '#E4E4E7', fontFamily: 'Inter, sans-serif',
      pointerEvents: 'none', transform: 'translateY(-14px)', whiteSpace: 'nowrap', lineHeight: '16px',
    }}>
      {day && <div style={{ color: '#636370', fontSize: 10, marginBottom: 3 }}>{day}</div>}
      <div style={{ fontWeight: 600 }}>{val.toLocaleString(undefined, { maximumFractionDigits: 2 })}{meta?.label ? ` ${meta.label}` : ''}</div>
      {meta?.details?.map(d => {
        const dv = d.data[idx];
        return dv != null ? <div key={d.label} style={{ color: '#A1A1AA', fontSize: 10 }}>{d.label}: {dv.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div> : null;
      })}
    </div>
  );
}

export function MiniAreaSparkline({ data, color = '#0098EA', meta }: { data: number[]; color?: string; meta?: SparkMeta }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.15} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip content={<SparkTip meta={meta} />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} wrapperStyle={{ zIndex: 50, overflow: 'visible' }} allowEscapeViewBox={{ x: true, y: true }} />
        <Area type="monotone" dataKey="v" stroke={color} fill={`url(#spark-${color.replace('#','')})`} strokeWidth={1.5} dot={false} activeDot={{ r: 2.5, fill: color, stroke: '#050508', strokeWidth: 2 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MiniBarSparkline({ data, color = '#0098EA', meta }: { data: number[]; color?: string; meta?: SparkMeta }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap="15%">
        <Tooltip content={<SparkTip meta={meta} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} wrapperStyle={{ zIndex: 50, overflow: 'visible' }} allowEscapeViewBox={{ x: true, y: true }} />
        <Bar dataKey="v" fill={color} fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function useSparklineData(jobs?: Job[]) {
  const [stats, setStats] = useState<DayStat[]>([]);
  useEffect(() => {
    fetch('/api/explorer/stats').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { if (Array.isArray(d)) setStats(d); }).catch(() => {});
  }, []);

  // Fallback: build stats from job data when API unavailable
  const effectiveStats = useMemo(() => {
    if (stats.length > 0) return stats;
    if (!jobs?.length) return [];
    const dayMap = new Map<string, DayStat>();
    for (const j of jobs) {
      if (!j.createdAt) continue;
      const day = new Date(j.createdAt * 1000).toISOString().slice(0, 10);
      const key = `${day}-${j.type}`;
      const entry = dayMap.get(key) || { day, factory_type: j.type, job_count: 0, volume: 0 };
      entry.job_count++;
      entry.volume += Number(BigInt(j.budget));
      dayMap.set(key, entry);
    }
    return Array.from(dayMap.values());
  }, [stats, jobs]);

  const sortedDays = useMemo(() => {
    if (!effectiveStats.length) return [] as string[];
    const s = new Set<string>();
    for (const st of effectiveStats) s.add(st.day);
    return Array.from(s).sort();
  }, [effectiveStats]);

  const dayLabels = useMemo(() => sortedDays.map(d => d.slice(5)), [sortedDays]);

  const cumJobs = useMemo(() => {
    if (!sortedDays.length) return [];
    const tonMap = new Map<string, number>(), usdtMap = new Map<string, number>();
    for (const s of effectiveStats) {
      if (s.factory_type === 'ton') tonMap.set(s.day, (tonMap.get(s.day) || 0) + Number(s.job_count));
      else usdtMap.set(s.day, (usdtMap.get(s.day) || 0) + Number(s.job_count));
    }
    let cumT = 0, cumU = 0;
    return sortedDays.map(d => { cumT += tonMap.get(d) || 0; cumU += usdtMap.get(d) || 0; return { total: cumT + cumU, ton: cumT, usdt: cumU }; });
  }, [effectiveStats, sortedDays]);

  const cumVolume = useMemo(() => {
    if (!sortedDays.length) return [];
    const tonMap = new Map<string, number>(), usdtMap = new Map<string, number>();
    for (const s of effectiveStats) {
      if (s.factory_type === 'ton') tonMap.set(s.day, (tonMap.get(s.day) || 0) + Number(s.volume) / 1e9);
      else usdtMap.set(s.day, (usdtMap.get(s.day) || 0) + Number(s.volume) / 1e6);
    }
    let cumT = 0, cumU = 0;
    return sortedDays.map(d => { cumT += tonMap.get(d) || 0; cumU += usdtMap.get(d) || 0; return { total: cumT + cumU, ton: cumT, usdt: cumU }; });
  }, [effectiveStats, sortedDays]);

  const jobsPerDay = useMemo(() => {
    if (!sortedDays.length) return [];
    const dayMap = new Map<string, number>();
    for (const s of effectiveStats) dayMap.set(s.day, (dayMap.get(s.day) || 0) + Number(s.job_count));
    return sortedDays.map(d => dayMap.get(d) || 0);
  }, [effectiveStats, sortedDays]);

  // Cumulative unique agents (clients, providers, evaluators) by day
  const cumAgents = useMemo(() => {
    if (!jobs?.length || !sortedDays.length) return { total: [] as number[], clients: [] as number[], providers: [] as number[], evaluators: [] as number[] };
    // Group jobs by day
    const jobsByDay = new Map<string, Job[]>();
    for (const j of jobs) {
      if (!j.createdAt) continue;
      const day = new Date(j.createdAt * 1000).toISOString().slice(0, 10);
      const arr = jobsByDay.get(day) || [];
      arr.push(j);
      jobsByDay.set(day, arr);
    }
    const allSeen = new Set<string>(), clientsSeen = new Set<string>(), provSeen = new Set<string>(), evalSeen = new Set<string>();
    const total: number[] = [], clients: number[] = [], providers: number[] = [], evaluators: number[] = [];
    for (const day of sortedDays) {
      const dayJobs = jobsByDay.get(day) || [];
      for (const j of dayJobs) {
        if (j.client) { clientsSeen.add(j.client); allSeen.add(j.client); }
        if (j.evaluator) { evalSeen.add(j.evaluator); allSeen.add(j.evaluator); }
        if (j.provider && j.provider !== 'none') { provSeen.add(j.provider); allSeen.add(j.provider); }
      }
      total.push(allSeen.size);
      clients.push(clientsSeen.size);
      providers.push(provSeen.size);
      evaluators.push(evalSeen.size);
    }
    return { total, clients, providers, evaluators };
  }, [jobs, sortedDays]);

  return {
    cumJobsTotal: cumJobs.map(c => c.total),
    cumJobsTon: cumJobs.map(c => c.ton),
    cumJobsUsdt: cumJobs.map(c => c.usdt),
    cumVolumeTotal: cumVolume.map(c => c.total),
    cumVolumeTon: cumVolume.map(c => c.ton),
    cumVolumeUsdt: cumVolume.map(c => c.usdt),
    cumAgentsTotal: cumAgents.total,
    cumAgentsClients: cumAgents.clients,
    cumAgentsProviders: cumAgents.providers,
    cumAgentsEvaluators: cumAgents.evaluators,
    jobsPerDay,
    days: dayLabels,
  };
}
