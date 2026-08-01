import { useEffect, useState } from 'react';
import { Trash2, Play, Pause } from 'lucide-react';
import { api } from '../api/client';

export default function Queue() {
  const [items, setItems] = useState<any[]>([]);
  const [paused, setPaused] = useState(false);

  const fetchQueue = async () => {
    try {
      const response = await api.get('/queue');
      setItems(response.data.data || []);
    } catch {
      // Leave the current list in place if the backend is unreachable.
    }
  };

  useEffect(() => {
    fetchQueue();
    const pollId = setInterval(fetchQueue, 3000);
    return () => clearInterval(pollId);
  }, []);

  const remove = async (itemId: number) => {
    await api.delete(`/queue/${itemId}`);
    fetchQueue();
  };

  const clear = async () => {
    await api.post('/queue/clear');
    fetchQueue();
  };

  const togglePause = async () => {
    if (paused) {
      await api.post('/queue/start');
      setPaused(false);
    } else {
      await api.post('/queue/pause');
      setPaused(true);
    }
  };

  const statusTone = (status: string) => {
    if (status === 'downloading') return 'bg-audora-500/20 text-audora-200';
    if (status === 'completed') return 'bg-emerald-500/12 text-emerald-300';
    if (status === 'failed') return 'bg-rose-500/12 text-rose-300';
    return 'bg-white/[0.06] text-gray-400';
  };

  return (
    <div className="animate-rise-in space-y-6 pt-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-100">Queue</h1>
        <span className="font-mono text-xs tabular-nums text-gray-500">
          {items.length} waiting
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={togglePause}
            className="flex items-center gap-2 rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 py-2 text-xs text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09]"
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={clear}
            disabled={items.length === 0}
            className="rounded-full px-3 py-2 text-xs text-rose-300 transition-colors hover:text-rose-200 disabled:text-gray-600"
          >
            Clear all
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing queued. Add a link from the Download page and it will line up here.
        </p>
      ) : (
        <div className="glass overflow-hidden rounded-2xl">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={`relative z-10 flex items-center gap-4 px-4 py-3 ${
                index > 0 ? 'border-t border-white/[0.05]' : ''
              }`}
            >
              <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-gray-600">
                {index + 1}
              </span>
              <p className="min-w-0 flex-1 truncate text-sm text-gray-100">
                {item.title || item.url}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(
                  item.status
                )}`}
              >
                {item.status}
              </span>
              <button
                onClick={() => remove(item.id)}
                disabled={item.status === 'downloading'}
                title={
                  item.status === 'downloading'
                    ? 'Stop this from the Download page'
                    : 'Remove from queue'
                }
                aria-label="Remove from queue"
                className="shrink-0 rounded text-gray-600 transition-colors hover:text-rose-300 disabled:text-gray-700 disabled:hover:text-gray-700"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
