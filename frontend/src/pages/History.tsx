import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { api } from '../api/client';

export default function History() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');

  const load = () =>
    api
      .get('/history')
      .then((r) => setItems(r.data.data || []))
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  const clear = async () => {
    await api.delete('/history');
    setItems([]);
  };

  const retry = async (id: number) => {
    await api.post(`/history/${id}/retry`);
  };

  const filtered = filter === 'all' ? items : items.filter((i) => i.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">History</h2>
        <div className="flex items-center gap-3">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button onClick={clear} className="text-sm text-red-400 hover:text-red-300">
            Clear History
          </button>
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="text-gray-500">No history yet.</p>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Tracks</th>
                <th className="px-4 py-3">Errors</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id} className="border-t border-gray-800">
                  <td className="px-4 py-3 text-gray-500">
                    {item.created_at ? new Date(item.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 truncate max-w-xs">{item.title || item.url}</td>
                  <td className="px-4 py-3">{item.track_count}</td>
                  <td className="px-4 py-3">{item.error_count || 0}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        item.status === 'completed'
                          ? 'bg-green-900 text-green-300'
                          : item.status === 'cancelled'
                          ? 'bg-gray-700 text-gray-300'
                          : 'bg-red-900 text-red-300'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => retry(item.id)}
                      title="Re-download"
                      className="text-gray-500 hover:text-violet-400 flex items-center gap-1"
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
