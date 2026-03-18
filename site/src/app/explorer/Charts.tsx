'use client';

import { useState, useEffect } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface DayStat { day: string; factory_type: string; job_count: number; volume: number; }

export function ExplorerCharts() {
  const [stats, setStats] = useState<DayStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/explorer/stats')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setStats(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="h-48 bg-[#111] border border-[#222] rounded-xl animate-pulse" />;
  if (!stats.length) return null;

  // Aggregate by day
  const dayMap = new Map<string, { day: string; tonJobs: number; usdtJobs: number; tonVol: number; usdtVol: number }>();
  for (const s of stats) {
    const key = s.day;
    const entry = dayMap.get(key) || { day: key, tonJobs: 0, usdtJobs: 0, tonVol: 0, usdtVol: 0 };
    if (s.factory_type === 'ton') {
      entry.tonJobs += Number(s.job_count);
      entry.tonVol += Number(s.volume) / 1e9;
    } else {
      entry.usdtJobs += Number(s.job_count);
      entry.usdtVol += Number(s.volume) / 1e6;
    }
    dayMap.set(key, entry);
  }
  const chartData = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
  if (!chartData.length) return null;

  // Cumulative volume
  let cumTon = 0, cumUsdt = 0;
  const volumeData = chartData.map(d => {
    cumTon += d.tonVol;
    cumUsdt += d.usdtVol;
    return { day: d.day.slice(5), tonVol: +cumTon.toFixed(2), usdtVol: +cumUsdt.toFixed(2) };
  });

  const barData = chartData.map(d => ({ day: d.day.slice(5), ton: d.tonJobs, usdt: d.usdtJobs }));

  const tooltipStyle = { backgroundColor: '#111', border: '1px solid #222', borderRadius: 8, fontSize: 12 };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <div className="bg-[#111] border border-[#222] rounded-xl p-4">
        <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Cumulative Volume</div>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={volumeData}>
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#555' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#555' }} axisLine={false} tickLine={false} width={40} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#888' }} />
            <Area type="monotone" dataKey="tonVol" name="TON" stroke="#0098EA" fill="#0098EA" fillOpacity={0.1} strokeWidth={2} />
            <Area type="monotone" dataKey="usdtVol" name="USDT" stroke="#26A17B" fill="#26A17B" fillOpacity={0.1} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="bg-[#111] border border-[#222] rounded-xl p-4">
        <div className="text-[#555] text-xs font-mono mb-3 uppercase tracking-wider">Jobs Per Day</div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={barData}>
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#555' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#555' }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#888' }} />
            <Bar dataKey="ton" name="TON" fill="#0098EA" radius={[4, 4, 0, 0]} />
            <Bar dataKey="usdt" name="USDT" fill="#26A17B" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
