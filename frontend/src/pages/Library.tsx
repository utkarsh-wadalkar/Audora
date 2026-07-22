import { useEffect, useMemo, useState } from 'react';
import { Music, Search, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import type { Track } from '../store/useAppStore';
import { formatDuration } from '../lib/format';

type Tab = 'tracks' | 'artists' | 'albums';
type Sort = 'title' | 'artist' | 'album';

export default function Library() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tab, setTab] = useState<Tab>('tracks');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('title');
  const [scanning, setScanning] = useState(false);

  const setCurrentTrack = useAppStore((s) => s.setCurrentTrack);

  const load = async () => {
    try {
      const r = await api.get('/library');
      setTracks(r.data.data || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    load();
  }, []);

  const rescan = async () => {
    setScanning(true);
    try {
      await api.post('/library/scan');
      await load();
    } finally {
      setScanning(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    let list = tracks;
    if (q) {
      list = tracks.filter(
        (t) =>
          (t.title || '').toLowerCase().includes(q) ||
          (t.artist || '').toLowerCase().includes(q) ||
          (t.album || '').toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) =>
      (a[sort] || '').toString().localeCompare((b[sort] || '').toString())
    );
  }, [tracks, query, sort]);

  const artists = useMemo(
    () => Array.from(new Set(tracks.map((t) => t.artist).filter(Boolean))).sort(),
    [tracks]
  );

  const albums = useMemo(() => {
    const map = new Map<string, { artist?: string; album?: string; count: number }>();
    tracks.forEach((t) => {
      const key = `${t.artist}::${t.album}`;
      const e = map.get(key) || { artist: t.artist, album: t.album, count: 0 };
      e.count += 1;
      map.set(key, e);
    });
    return Array.from(map.values());
  }, [tracks]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Library</h2>
        <button
          onClick={rescan}
          disabled={scanning}
          className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg flex items-center gap-1.5"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Scanning...' : 'Rescan'}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
          {(['tracks', 'artists', 'albums'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-sm capitalize ${
                tab === t ? 'bg-violet-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search library..."
            className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-violet-500"
          />
        </div>
        {tab === 'tracks' && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          >
            <option value="title">Sort: Title</option>
            <option value="artist">Sort: Artist</option>
            <option value="album">Sort: Album</option>
          </select>
        )}
      </div>

      {tracks.length === 0 ? (
        <p className="text-gray-500">No tracks found. Download some music first.</p>
      ) : tab === 'tracks' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((track) => (
            <button
              key={track.file_path}
              onClick={() => setCurrentTrack(track)}
              className="text-left bg-gray-900 rounded-xl p-4 border border-gray-800 hover:border-violet-500/50 transition-colors cursor-pointer group"
            >
              <div className="w-full aspect-square bg-gray-800 rounded-lg mb-3 flex items-center justify-center text-gray-600 group-hover:text-violet-400 overflow-hidden">
                {track.id ? (
                  <img
                    src={`${api.defaults.baseURL}/library/art/${track.id}`}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Music size={32} />
                )}
              </div>
              <p className="font-medium truncate">{track.title}</p>
              <p className="text-sm text-gray-500 truncate">{track.artist}</p>
              <p className="text-xs text-gray-600 mt-1">{formatDuration(track.duration)}</p>
            </button>
          ))}
        </div>
      ) : tab === 'artists' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {artists
            .filter((a) => a!.toLowerCase().includes(query.toLowerCase()))
            .map((a) => (
              <div key={a} className="bg-gray-900 rounded-lg p-4 border border-gray-800">
                <p className="font-medium truncate">{a}</p>
                <p className="text-xs text-gray-500">
                  {tracks.filter((t) => t.artist === a).length} tracks
                </p>
              </div>
            ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {albums
            .filter((al) => (al.album || '').toLowerCase().includes(query.toLowerCase()))
            .map((al) => (
              <div
                key={`${al.artist}::${al.album}`}
                className="bg-gray-900 rounded-lg p-4 border border-gray-800"
              >
                <p className="font-medium truncate">{al.album}</p>
                <p className="text-sm text-gray-500 truncate">{al.artist}</p>
                <p className="text-xs text-gray-600 mt-1">{al.count} tracks</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
