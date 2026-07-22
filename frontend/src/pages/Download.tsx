import { useState, useEffect, useRef } from 'react';
import { Download, X, ListPlus } from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore } from '../store/useAppStore';

const FORMATS = [
  { value: 'alac', label: 'ALAC (Lossless)' },
  { value: 'aac', label: 'AAC' },
  { value: 'atmos', label: 'Dolby Atmos' },
];

export default function DownloadPage() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState('alac');
  const [isDownloading, setIsDownloading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<any>(null);
  const [error, setError] = useState('');
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addToQueue = useAppStore((s) => s.addToQueue);

  useWebSocket('/ws/logs', {
    onMessage: (data) => {
      if (data?.type === 'log') {
        setLogs((prev) => [...prev.slice(-200), `[${data.level}] ${data.message}`]);
      }
    },
  });

  useWebSocket('/ws/progress', {
    onMessage: (data) => {
      setProgress(data);
      if (data?.status === 'completed' || data?.status === 'failed' || data?.status === 'cancelled') {
        setIsDownloading(false);
      } else if (data?.status === 'downloading') {
        setIsDownloading(true);
      }
    },
  });

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const isValidUrl = /music\.apple\.com/.test(url);

  const handleDownload = async () => {
    if (!isValidUrl) {
      setError('Please enter a valid Apple Music URL.');
      return;
    }
    setError('');
    setIsDownloading(true);
    setLogs([]);
    setProgress(null);
    try {
      const res = await api.post('/download', { url, format });
      if (!res.data.success) {
        setError(res.data.error || 'Failed to start download');
        setIsDownloading(false);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message);
      setIsDownloading(false);
    }
  };

  const handleQueue = async () => {
    if (!isValidUrl) {
      setError('Please enter a valid Apple Music URL.');
      return;
    }
    setError('');
    await addToQueue(url);
    setUrl('');
  };

  const handleCancel = async () => {
    await api.post('/download/cancel');
    setIsDownloading(false);
  };

  const pct = progress?.total_tracks
    ? (progress.current_track / progress.total_tracks) * 100
    : 0;

  return (
    <div className="space-y-6 h-full flex flex-col">
      <h2 className="text-2xl font-bold">Download</h2>

      <div className="space-y-3">
        <div className="flex gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste Apple Music URL (album, playlist, track...)"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-violet-500"
          />
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 text-sm focus:outline-none focus:border-violet-500"
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-3">
          {isDownloading ? (
            <button
              onClick={handleCancel}
              className="bg-red-600 hover:bg-red-500 px-5 py-3 rounded-lg flex items-center gap-2"
            >
              <X size={18} /> Cancel
            </button>
          ) : (
            <button
              onClick={handleDownload}
              className="bg-violet-600 hover:bg-violet-500 px-5 py-3 rounded-lg flex items-center gap-2"
            >
              <Download size={18} /> Download Now
            </button>
          )}
          <button
            onClick={handleQueue}
            disabled={isDownloading}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-5 py-3 rounded-lg flex items-center gap-2 text-sm"
          >
            <ListPlus size={18} /> Add to Queue
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {progress && progress.status === 'downloading' && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="flex justify-between text-sm mb-2">
            <span>{progress.track_name || 'Starting...'}</span>
            <span>
              {progress.current_track || 0} / {progress.total_tracks || '?'}
            </span>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {(progress.completed || progress.failed) ? (
            <p className="text-xs text-gray-500 mt-2">
              {progress.completed || 0} completed · {progress.failed || 0} failed
            </p>
          ) : null}
        </div>
      )}

      <div className="flex-1 bg-gray-950 rounded-lg border border-gray-800 p-4 font-mono text-xs overflow-y-auto scrollbar-thin space-y-1">
        {logs.map((line, i) => (
          <div key={i} className="text-gray-400">
            {line}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
