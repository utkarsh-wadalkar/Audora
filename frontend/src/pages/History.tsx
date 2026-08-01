import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { api } from '../api/client';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function History() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');

  const load = () =>
    api
      .get('/history')
      .then((response) => setItems(response.data.data || []))
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  const clear = async () => {
    await api.delete('/history');
    setItems([]);
  };

  const retry = async (itemId: number) => {
    await api.post(`/history/${itemId}/retry`);
  };

  const filtered = filter === 'all' ? items : items.filter((item) => item.status === filter);

  const statusTone = (status: string) => {
    if (status === 'completed') return 'bg-emerald-500/12 text-emerald-300';
    if (status === 'cancelled') return 'bg-white/[0.06] text-gray-400';
    return 'bg-rose-500/12 text-rose-300';
  };

  return (
    <div className="animate-rise-in space-y-6 pt-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-100">History</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* Segmented filter — the four states are few enough to show at once,
              which beats hiding them behind a select. */}
          <div className="flex gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                onClick={() => setFilter(option.value)}
                aria-pressed={filter === option.value}
                className={`rounded-full px-3 py-1.5 text-xs transition-colors duration-300 ease-out ${
                  filter === option.value
                    ? 'bg-audora-500/22 text-audora-100'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            onClick={clear}
            disabled={items.length === 0}
            className="rounded-full px-3 py-2 text-xs text-rose-300 transition-colors hover:text-rose-200 disabled:text-gray-600"
          >
            Clear
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500">
          {items.length === 0
            ? 'No downloads yet. Finished jobs are listed here so you can re-run them.'
            : `No ${filter} downloads.`}
        </p>
      ) : (
        <div className="glass overflow-hidden rounded-2xl">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.07] text-[11px] uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 text-right font-medium">Tracks</th>
                <th className="px-4 py-3 text-right font-medium">Errors</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="relative z-10">
              {filtered.map((item) => (
                <tr
                  key={item.id}
                  className="border-t border-white/[0.05] transition-colors hover:bg-white/[0.03]"
                >
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs tabular-nums text-gray-500">
                    {item.created_at
                      ? new Date(item.created_at).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="max-w-sm truncate px-4 py-3 text-gray-100">
                    {item.title || item.url}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-gray-300">
                    {item.track_count}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-gray-500">
                    {item.error_count || 0}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(
                        item.status
                      )}`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => retry(item.id)}
                      title="Download this again"
                      aria-label="Download this again"
                      className="rounded text-gray-600 transition-colors hover:text-audora-300"
                    >
                      <RotateCw size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
