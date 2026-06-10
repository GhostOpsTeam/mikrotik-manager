import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Activity, ArrowDown, ArrowUp, BarChart3, Settings2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import clsx from 'clsx';
import { trafficApi } from '../services/api';

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

const APP_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#a855f7',
  '#64748b', '#0ea5e9', '#d946ef', '#22c55e',
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function timeFormatter(range: Range) {
  return (t: string) => {
    try {
      const d = parseISO(t);
      return range === '7d' || range === '30d' ? format(d, 'MMM d') : format(d, 'HH:mm');
    } catch {
      return t;
    }
  };
}

function clientLabel(c: { mac: string; custom_name: string | null; hostname: string | null; vendor: string | null }): string {
  if (c.mac === 'unknown') return 'Unattributed (local)';
  if (c.mac === 'other') return 'Other clients';
  return c.custom_name || c.hostname || c.vendor || c.mac;
}

export default function TrafficAnalyticsPage() {
  const [range, setRange] = useState<Range>('24h');
  const navigate = useNavigate();

  const { data: series = [], isLoading: seriesLoading } = useQuery({
    queryKey: ['traffic-timeseries', range],
    queryFn: () => trafficApi.timeseries(range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const { data: topClients = [], isLoading: clientsLoading } = useQuery({
    queryKey: ['traffic-top-clients', range],
    queryFn: () => trafficApi.topClients(range, 10).then(r => r.data),
    refetchInterval: 60_000,
  });

  const { data: apps = [], isLoading: appsLoading } = useQuery({
    queryKey: ['traffic-apps', range],
    queryFn: () => trafficApi.apps(range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const isLoading = seriesLoading || clientsLoading || appsLoading;
  const hasData = series.length > 0 || topClients.length > 0 || apps.length > 0;

  const totalUpload = series.reduce((s, p) => s + p.upload, 0);
  const totalDownload = series.reduce((s, p) => s + p.download, 0);
  const totalAppBytes = apps.reduce((s, a) => s + a.bytes, 0);
  const maxClientBytes = topClients[0]?.total_bytes || 1;

  // Donut: top 8 categories, rest folded into "Other"
  const donutData = (() => {
    const top = apps.slice(0, 8);
    const rest = apps.slice(8).reduce((s, a) => s + a.bytes, 0);
    return rest > 0 ? [...top, { app: 'Other', bytes: rest }] : top;
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Traffic</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Per-client traffic analytics from NetFlow/IPFIX</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="card p-1 flex rounded-lg gap-1">
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={clsx('px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  range === r
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700')}>
                {r}
              </button>
            ))}
          </div>
          <Link to="/network-services/netflow"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            <Settings2 className="w-3.5 h-3.5" />Configure
          </Link>
        </div>
      </div>

      {/* Empty state */}
      {!isLoading && !hasData && (
        <div className="card p-12 text-center space-y-3">
          <Activity className="w-10 h-10 mx-auto text-gray-300 dark:text-slate-600" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">No traffic data yet</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 max-w-md mx-auto">
            Enable the NetFlow collector and turn on traffic export for your routers to start
            collecting per-client usage and protocol analytics.
          </p>
          <Link to="/network-services/netflow"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <Settings2 className="w-3.5 h-3.5" />Set up NetFlow
          </Link>
        </div>
      )}

      {hasData && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <ArrowDown className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Download ({range})</div>
                <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(totalDownload)}</div>
              </div>
            </div>
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-100 dark:bg-violet-900/30">
                <ArrowUp className="w-5 h-5 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Upload ({range})</div>
                <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(totalUpload)}</div>
              </div>
            </div>
          </div>

          {/* Throughput chart */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200 mb-4">Network Traffic</h2>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={series}>
                <defs>
                  <linearGradient id="dl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ul" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-slate-700" />
                <XAxis dataKey="time" tickFormatter={timeFormatter(range)} tick={{ fontSize: 11 }} stroke="currentColor" />
                <YAxis tickFormatter={v => formatBytes(v)} tick={{ fontSize: 11 }} width={70} stroke="currentColor" />
                <Tooltip
                  labelFormatter={t => { try { return format(parseISO(String(t)), 'MMM d, HH:mm'); } catch { return String(t); } }}
                  formatter={(value: number, name: string) => [formatBytes(value), name === 'download' ? 'Download' : 'Upload']}
                />
                <Legend formatter={(v: string) => (v === 'download' ? 'Download' : 'Upload')} />
                <Area type="monotone" dataKey="download" stroke="#3b82f6" fill="url(#dl)" strokeWidth={2} />
                <Area type="monotone" dataKey="upload" stroke="#8b5cf6" fill="url(#ul)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top talkers */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-blue-500" />
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Top Talkers</h2>
              </div>
              {topClients.length === 0
                ? <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No client traffic recorded.</div>
                : (
                  <div className="divide-y divide-gray-100 dark:divide-slate-800">
                    {topClients.map(c => {
                      const isReal = c.mac !== 'unknown' && c.mac !== 'other';
                      return (
                        <div key={c.mac}
                          onClick={() => isReal && navigate(`/clients/${encodeURIComponent(c.mac)}`)}
                          className={clsx('px-5 py-3', isReal && 'cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700/40 transition-colors')}>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{clientLabel(c)}</span>
                              {isReal && (
                                <span className="ml-2 font-mono text-xs text-gray-400 dark:text-slate-500">{c.ip_address || c.mac}</span>
                              )}
                            </div>
                            <span className="text-sm font-semibold text-gray-700 dark:text-slate-200 flex-shrink-0">{formatBytes(c.total_bytes)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                            <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.max(2, (c.total_bytes / maxClientBytes) * 100)}%` }} />
                          </div>
                          <div className="mt-1 flex gap-3 text-xs text-gray-400 dark:text-slate-500">
                            <span className="inline-flex items-center gap-0.5"><ArrowDown className="w-3 h-3" />{formatBytes(c.download_bytes)}</span>
                            <span className="inline-flex items-center gap-0.5"><ArrowUp className="w-3 h-3" />{formatBytes(c.upload_bytes)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>

            {/* App categories */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Traffic by Application</h2>
              </div>
              {apps.length === 0
                ? <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No application data recorded.</div>
                : (
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={donutData} dataKey="bytes" nameKey="app" innerRadius={55} outerRadius={85} paddingAngle={2}>
                          {donutData.map((entry, i) => (
                            <Cell key={entry.app} fill={APP_COLORS[i % APP_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number, name: string) => [formatBytes(value), name]} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-2 space-y-1.5">
                      {apps.slice(0, 10).map((a, i) => (
                        <div key={a.app} className="flex items-center gap-2 text-sm">
                          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: APP_COLORS[i % APP_COLORS.length] }} />
                          <span className="text-gray-700 dark:text-slate-300 flex-1 truncate">{a.app}</span>
                          <span className="text-gray-500 dark:text-slate-400 text-xs">
                            {totalAppBytes > 0 ? `${((a.bytes / totalAppBytes) * 100).toFixed(1)}%` : ''}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-white w-20 text-right">{formatBytes(a.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
