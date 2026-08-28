import { useEffect, useMemo, useState } from 'react';
import { Music, Search, RefreshCw, Play } from 'lucide-react';
import { api, API_BASE } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import type { Track } from '../store/useAppStore';
import { formatDuration } from '../lib/format';

type Tab = 'tracks' | 'artists' | 'albums';
type Sort = 'title' | 'artist' | 'album';

interface AlbumGroup {
  folder_path: string;
  artist?: string;
  album?: string;
  tracks: Track[];
}

const TABS: Tab[] = ['tracks', 'artists', 'albums'];
const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareTracks(first: Track, second: Track, sort: Sort) {
  const primary = naturalName.compare(first[sort] || '', second[sort] || '');
  if (primary) return primary;
  // Keep each album together and give its songs a predictable file-system-like
  // order instead of falling back to the backend's artist insertion order.
  const byTitle = naturalName.compare(first.title || '', second.title || '');
  return byTitle || naturalName.compare(first.file_path, second.file_path);
}

function AlbumArt({ trackId, size = 28 }: { trackId?: number; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (!trackId || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-gray-600">
        <Music size={size} />
      </div>
    );
  }

  return (
    <img
      src={`${API_BASE}/library/art/${trackId}`}
      alt=""
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/** Album art with a hover play affordance, shared by the track and album grids. */
function ArtworkTile({ trackId }: { trackId?: number }) {
  return (
    <div className="relative mb-3 aspect-square overflow-hidden rounded-xl border border-white/[0.08] shadow-glass">
      <AlbumArt trackId={trackId} />
      <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-audora-500 text-white shadow-knob">
          <Play size={15} fill="currentColor" className="ml-0.5" />
        </span>
      </div>
    </div>
  );
}

export default function Library() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<AlbumGroup[]>([]);
  const [tab, setTab] = useState<Tab>('tracks');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('title');
  const [scanning, setScanning] = useState(false);

  const playTracks = useAppStore((s) => s.playTracks);

  const load = async () => {
    try {
      const [tracksResponse, albumsResponse] = await Promise.all([
        api.get('/library'),
        api.get('/library/albums'),
      ]);
      setTracks(tracksResponse.data.data || []);
      setAlbums(albumsResponse.data.data || []);
    } catch {
      // Leave the current list in place if the backend is unreachable.
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

  const needle = query.toLowerCase().trim();

  const filtered = useMemo(() => {
    let list = tracks;
    if (needle) {
      list = tracks.filter((track) =>
        [track.title, track.artist, track.album].some((field) =>
          (field || '').toLowerCase().includes(needle)
        )
      );
    }
    return [...list].sort((first, second) => compareTracks(first, second, sort));
  }, [tracks, needle, sort]);

  const artists = useMemo(() => {
    const byArtist = new Map<
      string,
      { name: string; count: number; artTrackId?: number; tracks: Track[] }
    >();
    tracks.forEach((track) => {
      const name = track.artist || 'Unknown artist';
      const existing = byArtist.get(name);
      if (existing) {
        existing.count += 1;
        existing.tracks.push(track);
      } else {
        byArtist.set(name, { name, count: 1, artTrackId: track.id, tracks: [track] });
      }
    });
    return Array.from(byArtist.values()).sort((first, second) =>
      first.name.localeCompare(second.name)
    );
  }, [tracks]);

  return (
    <div className="animate-rise-in space-y-6 pt-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-100">Library</h1>
        <span className="font-mono text-xs tabular-nums text-gray-500">
          {tracks.length} tracks
        </span>
        <button
          onClick={rescan}
          disabled={scanning}
          className="ml-auto flex items-center gap-2 rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 py-2 text-xs text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09] disabled:text-gray-500"
        >
          <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="glass flex items-center gap-1 rounded-full p-1">
          {TABS.map((candidate) => (
            <button
              key={candidate}
              onClick={() => setTab(candidate)}
              className={`relative z-10 rounded-full px-4 py-1.5 text-xs font-medium capitalize transition-colors duration-300 ease-out ${
                tab === candidate
                  ? 'bg-white/[0.10] text-white'
                  : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>

        <div className="glass flex flex-1 items-center gap-2.5 rounded-full px-4 py-2">
          <Search size={14} className="relative z-10 shrink-0 text-gray-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this library"
            className="relative z-10 w-full bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
          />
        </div>

        {tab === 'tracks' && (
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            aria-label="Sort tracks"
            className="rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 py-2 text-xs text-gray-200 focus:outline-none"
          >
            <option value="title">Sort: Title</option>
            <option value="artist">Sort: Artist</option>
            <option value="album">Sort: Album</option>
          </select>
        )}
      </div>

      {tracks.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing here yet. Download an album and it will appear once scanned.
        </p>
      ) : tab === 'tracks' ? (
        <div className="grid grid-cols-4 gap-4">
          {filtered.map((track) => (
            <button
              key={track.file_path}
              onClick={() => playTracks(filtered, track)}
              className="group text-left"
            >
              <ArtworkTile trackId={track.id} />
              <p className="truncate text-sm font-medium text-gray-100">{track.title}</p>
              <p className="truncate text-xs text-gray-500">{track.artist}</p>
              <p className="mt-0.5 font-mono text-[10px] tabular-nums text-gray-600">
                {formatDuration(track.duration)}
              </p>
            </button>
          ))}
        </div>
      ) : tab === 'artists' ? (
        <div className="grid grid-cols-3 gap-3">
          {artists
            .filter((artist) => artist.name.toLowerCase().includes(needle))
            .map((artist) => (
              <button
                key={artist.name}
                onClick={() => playTracks(artist.tracks, artist.tracks[0])}
                aria-label={`Play songs by ${artist.name}`}
                className="glass glass-hover group flex items-center gap-3 rounded-2xl p-3 text-left"
              >
                <div className="relative z-10 h-11 w-11 shrink-0 overflow-hidden rounded-full">
                  <AlbumArt trackId={artist.artTrackId} size={16} />
                </div>
                <div className="relative z-10 min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-100">{artist.name}</p>
                  <p className="text-xs text-gray-500">{artist.count} tracks</p>
                </div>
                <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-audora-500 text-white opacity-80 shadow-knob transition-opacity group-hover:opacity-100">
                  <Play size={13} fill="currentColor" className="ml-0.5" />
                </span>
              </button>
            ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-4">
          {albums
            .filter((album) => (album.album || '').toLowerCase().includes(needle))
            .map((album) => (
              <button
                key={album.folder_path}
                onClick={() => playTracks(album.tracks, album.tracks[0])}
                className="group text-left"
              >
                <ArtworkTile trackId={album.tracks[0]?.id} />
                <p className="truncate text-sm font-medium text-gray-100">
                  {album.album || 'Unknown album'}
                </p>
                <p className="truncate text-xs text-gray-500">{album.artist}</p>
                <p className="mt-0.5 font-mono text-[10px] tabular-nums text-gray-600">
                  {album.tracks.length} tracks
                </p>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
