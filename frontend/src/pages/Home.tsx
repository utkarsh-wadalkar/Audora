import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Music, HardDrive, Clock } from 'lucide-react';
import { api } from '../api/client';
import { formatSize } from '../lib/format';

export default function Home() {
  const [stats, setStats] = useState({ tracks: 0, size: '0 MB' });
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    api.get('/library').then((r) => {
      const tracks = r.data.data || [];
      const size = tracks.reduce((acc: number, t: any) => acc + (t.file_size || 0), 0);
      setStats({ tracks: tracks.length, size: formatSize(size) });
    }).catch(() => {});
    api.get('/history').then((r) => {
      setRecent((r.data.data || []).slice(0, 5));
    }).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={Music} label="Total Tracks" value={stats.tracks.toString()} />
        <StatCard icon={HardDrive} label="Library Size" value={stats.size} />
        <StatCard icon={Clock} label="Recent Downloads" value={recent.length.toString()} />
      </div>
      <div>
        <h3 className="text-lg font-semibold mb-3">Recent Downloads</h3>
        {recent.length === 0 ? (
          <p className="text-gray-500">
            No downloads yet.{' '}
            <Link to="/download" className="text-violet-400 underline">
              Start one now
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-2">
            {recent.map((item) => (
              <div
                key={item.id}
                className="bg-gray-900 rounded-lg p-3 flex justify-between items-center"
              >
                <span className="truncate">{item.title || item.url}</span>
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    item.status === 'completed'
                      ? 'bg-green-900 text-green-300'
                      : 'bg-red-900 text-red-300'
                  }`}
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: any) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div className="flex items-center gap-3 mb-2">
        <Icon size={20} className="text-violet-400" />
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
