import { useEffect, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api/client';
import LogTerminal, { type LogLine } from '../components/LogTerminal';

const LEVEL_FILTERS = ['ALL', 'INFO', 'WARNING', 'ERROR'];

/** Bounded so a long session cannot grow the buffer without limit. */
const MAX_LOG_ENTRIES = 500;

export default function Logs() {
  const [entries, setEntries] = useState<any[]>([]);
  const [filter, setFilter] = useState('ALL');
  const [copied, setCopied] = useState(false);

  // Seed with recent logs, then stream live.
  useEffect(() => {
    api
      .get('/logs')
      .then((response) => setEntries(response.data.data || []))
      .catch(() => {});
  }, []);

  useWebSocket('/ws/logs', {
    onMessage: (data) => {
      if (data?.type === 'log') {
        setEntries((previous) => [...previous.slice(-(MAX_LOG_ENTRIES - 1)), data]);
      }
    },
  });

  const filtered = useMemo(
    () => (filter === 'ALL' ? entries : entries.filter((entry) => entry.level === filter)),
    [entries, filter]
  );

  // The backend already supplies a timestamp per entry, so index is a stable
  // enough key for an append-only, bounded buffer.
  const lines: LogLine[] = useMemo(
    () =>
      filtered.map((entry, index) => ({
        id: index,
        timestamp: entry.timestamp ?? '',
        level: typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info',
        prefix: entry.level,
        text: String(entry.message ?? ''),
      })),
    [filtered]
  );

  const copyAll = () => {
    const text = filtered
      .map((entry) => `[${entry.timestamp}] [${entry.level}] ${entry.message}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex h-full min-h-0 animate-rise-in flex-col gap-5 pt-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-100">Logs</h1>
        <span className="font-mono text-xs tabular-nums text-gray-500">
          {filtered.length} lines
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
            {LEVEL_FILTERS.map((level) => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                aria-pressed={filter === level}
                className={`rounded-full px-3 py-1.5 text-[11px] transition-colors duration-300 ease-out ${
                  filter === level
                    ? 'bg-audora-500/22 text-audora-100'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {level === 'ALL' ? 'All' : level}
              </button>
            ))}
          </div>
          <button
            onClick={copyAll}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 py-2 text-xs text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09] disabled:text-gray-600"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <LogTerminal
        title="Application log"
        lines={lines}
        idleHint="no log output yet"
        className="min-h-0 flex-1"
      />
    </div>
  );
}
