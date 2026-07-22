import { useEffect, useState } from 'react';
import { Trash2, Play, Pause } from 'lucide-react';
import { api } from '../api/client';

export default function Queue() {
  const [items, setItems] = useState<any[]>([]);
  const [paused, setPaused] = useState(false);

  const fetchQueue = async () => {
    try {
      const res = await api.get('/queue');
      setItems(res.data.data || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchQueue();
    const id = setInterval(fetchQueue, 3000);
    return () => clearInterval(id);
  }, []);

  const remove = async (id: number) => {
    await api.delete(`/queue/${id}`);
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

  const statusColor = (status: string) => {
    switch (status) {
      case 'downloading':
        return 'text-violet-300';
      case 'completed':
        return 'text-green-400';
      case 'failed':
        return 'text-red-400';
      default:
        return 'text-gray-500';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Queue</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePause}
            className="text-sm flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clear} className="text-sm text-red-400 hover:text-red-300">
            Clear All
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-gray-500">Queue is empty.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div
              key={item.id}
              className="bg-gray-900 rounded-lg p-4 flex justify-between items-center border border-gray-800"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-gray-600 text-sm w-6 text-right">{idx + 1}</span>
                <div className="min-w-0">
                  <p className="font-medium truncate max-w-md">{item.title || item.url}</p>
                  <span className={`text-xs uppercase ${statusColor(item.status)}`}>
                    {item.status}
                  </span>
                </div>
              </div>
              <button
                onClick={() => remove(item.id)}
                className="text-gray-500 hover:text-red-400"
                disabled={item.status === 'downloading'}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
