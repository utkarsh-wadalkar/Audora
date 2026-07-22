import { useEffect, useState, useRef } from 'react';
import { Copy, Check } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api/client';

export default function Logs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [filter, setFilter] = useState('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Seed with recent logs, then stream live.
  useEffect(() => {
    api
      .get('/logs')
      .then((r) => setLogs(r.data.data || []))
      .catch(() => {});
  }, []);

  useWebSocket('/ws/logs', {
    onMessage: (data) => {
      if (data?.type === 'log') {
        setLogs((prev) => [...prev.slice(-500), data]);
      }
    },
  });

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, autoScroll]);

  const filtered = filter === 'ALL' ? logs : logs.filter((l) => l.level === filter);

  const copyAll = () => {
    const text = filtered
      .map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Logs</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-violet-500"
            />
            Auto-scroll
          </label>
          <button
            onClick={copyAll}
            className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg flex items-center gap-1.5"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm"
          >
            <option value="ALL">All Levels</option>
            <option value="INFO">INFO</option>
            <option value="WARNING">WARNING</option>
            <option value="ERROR">ERROR</option>
          </select>
        </div>
      </div>
      <div className="flex-1 bg-gray-950 rounded-lg border border-gray-800 p-4 font-mono text-xs overflow-y-auto scrollbar-thin space-y-1">
        {filtered.map((log, i) => (
          <div
            key={i}
            className={
              log.level === 'ERROR'
                ? 'text-red-400'
                : log.level === 'WARNING'
                ? 'text-yellow-400'
                : 'text-gray-400'
            }
          >
            <span className="text-gray-600">[{log.timestamp}]</span> [{log.level}] {log.message}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
