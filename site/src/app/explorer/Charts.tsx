'use client';

import { useState, useEffect, useMemo } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Job } from './shared';

interface DayStat { day: string; factory_type: string; job_count: number; volume: number; }

const VolumeTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0a0a0a', border: '1px solid #222', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#888', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          <span>{p.name}: {Number(p.value).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
};

const JobsTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0a0a0a', border: '1px solid #222', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#888', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
          <span>{p.name}: {Math.round(p.value)}</span>
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

/** Main explorer charts */
export function ExplorerCharts() {
  const [stats, setStats] = useState<DayStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/explorer/stats').then(r => r.json()).then(d => { if (Array.isArray(d)) setStats(d); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="h-48 bg-[#111] border border-[#222] rounded-xl animate-pulse" />;
  if (!stats.length) return null;

  const chartData = buildChartData(stats);
  return <ChartPair data={chartData} showBoth />;
}

/** Factory-specific charts */
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
  const color = type === 'ton' ? '#0098EA' : '#26A17B';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <ChartCard title={`Volume (${type === 'ton' ? 'TON' : 'USDT'})`}>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={volumeData}>
            <CartesianGrid stroke="#1a1a1a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} width={40} />
            <Tooltip content={<VolumeTooltip />} cursor={{ stroke: '#333', strokeWidth: 1 }} />
            <Area type="monotone" dataKey="vol" name={type.toUpperCase()} stroke={color} fill={color} fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: color, stroke: '#0a0a0a', strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Jobs Per Day">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={barData}>
            <CartesianGrid stroke="#1a1a1a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
            <Tooltip content={<JobsTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="jobs" name="Jobs" fill={color} fillOpacity={0.8} radius={[4, 4, 0, 0]} />
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
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={volumeData}>
            <CartesianGrid stroke="#1a1a1a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} width={40} />
            <Tooltip content={<VolumeTooltip />} cursor={{ stroke: '#333', strokeWidth: 1 }} />
            <Area type="monotone" dataKey="tonVol" name="TON" stroke="#0098EA" fill="#0098EA" fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#0098EA', stroke: '#0a0a0a', strokeWidth: 2 }} />
            {showBoth && <Area type="monotone" dataKey="usdtVol" name="USDT" stroke="#26A17B" fill="#26A17B" fillOpacity={0.08} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#26A17B', stroke: '#0a0a0a', strokeWidth: 2 }} />}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Jobs Per Day">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={barData}>
            <CartesianGrid stroke="#1a1a1a" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} />
            <YAxis orientation="right" tick={{ fontSize: 10, fill: '#444' }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
            <Tooltip content={<JobsTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="ton" name="TON" fill="#0098EA" fillOpacity={0.8} radius={[4, 4, 0, 0]} />
            {showBoth && <Bar dataKey="usdt" name="USDT" fill="#26A17B" fillOpacity={0.8} radius={[4, 4, 0, 0]} />}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-4">
      <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">{title}</div>
      {children}
    </div>
  );
}
