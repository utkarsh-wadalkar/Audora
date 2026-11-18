import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUp, ArrowDown, Music, Search, RefreshCw, Play, ListPlus, ListMusic, Trash2, Plus, Pencil, Check, X } from 'lucide-react';
import { api, API_BASE } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import type { Track } from '../store/useAppStore';
import { formatDuration } from '../lib/format';

type Tab = 'tracks' | 'artists' | 'albums' | 'playlists';
type Sort = 'title' | 'artist' | 'album';

interface AlbumGroup {
  folder_path: string;
  artist?: string;
  album?: string;
  tracks: Track[];
}

interface PlaylistEntry {
  entry_id: number;
  file_path: string;
  track: Track | null;
}

interface Playlist {
  id: number;
  name: string;
  tracks: PlaylistEntry[];
}

const TABS: Tab[] = ['tracks', 'artists', 'albums', 'playlists'];
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
function ArtworkTile({ trackId, showPlay = true }: { trackId?: number; showPlay?: boolean }) {
  return (
    <div className="relative mb-3 aspect-square overflow-hidden rounded-xl border border-white/[0.08] shadow-glass">
      <AlbumArt trackId={trackId} />
      {showPlay && <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-audora-500 text-white shadow-knob">
          <Play size={15} fill="currentColor" className="ml-0.5" />
        </span>
      </div>}
    </div>
  );
}

function TrackActions({ track, playlists, onPlayNext, onQueueLast, onAddToPlaylist }: {
  track: Track;
  playlists: Playlist[];
  onPlayNext: (track: Track) => void;
  onQueueLast: (track: Track) => void;
  onAddToPlaylist: (playlistId: number, track: Track) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button onClick={() => onPlayNext(track)} title="Play next" aria-label={`Play ${track.title || 'track'} next`} className="rounded-lg p-1.5 text-gray-500 hover:bg-white/[0.08] hover:text-audora-300"><ListPlus size={16} /></button>
      <button onClick={() => onQueueLast(track)} title="Add to end of Up Next" aria-label={`Add ${track.title || 'track'} to queue`} className="rounded-lg p-1.5 text-gray-500 hover:bg-white/[0.08] hover:text-audora-300"><ListMusic size={16} /></button>
      <select
        value=""
        onChange={(event) => onAddToPlaylist(Number(event.target.value), track)}
        aria-label={`Add ${track.title || 'track'} to playlist`}
        title="Add to playlist"
        className="max-w-32 rounded-lg border border-white/[0.08] bg-[#23222b] px-2 py-1 text-xs text-gray-300"
      >
        <option value="" disabled>Playlist…</option>
        {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
      </select>
    </div>
  );
}

export default function Library() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<AlbumGroup[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [tab, setTab] = useState<Tab>('tracks');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('title');
  const [scanning, setScanning] = useState(false);
  const [openAlbumPath, setOpenAlbumPath] = useState<string | null>(null);
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [playlistError, setPlaylistError] = useState('');
  const [playlistStatus, setPlaylistStatus] = useState('');
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<number | null>(null);
  const [editedPlaylistName, setEditedPlaylistName] = useState('');

  const playTracks = useAppStore((s) => s.playTracks);
  const addPlayNext = useAppStore((s) => s.addPlayNext);
  const addToPlaybackEnd = useAppStore((s) => s.addToPlaybackEnd);

  const load = async () => {
    try {
      const [tracksResponse, albumsResponse] = await Promise.all([
        api.get('/library'),
        api.get('/library/albums'),
      ]);
      setTracks(tracksResponse.data.data || []);
      setAlbums(albumsResponse.data.data || []);
      try {
        const playlistsResponse = await api.get('/playlists');
        setPlaylists(playlistsResponse.data.data || []);
      } catch {
        setPlaylistError('Playlists are unavailable. Your library is still ready to play.');
      }
    } catch {
      // Leave the current list in place if the backend is unreachable.
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!playlistStatus) return;
    const timer = window.setTimeout(() => setPlaylistStatus(''), 3000);
    return () => window.clearTimeout(timer);
  }, [playlistStatus]);

  const rescan = async () => {
    setScanning(true);
    try {
      await api.post('/library/scan');
      await load();
    } finally {
      setScanning(false);
    }
  };

  const refreshPlaylists = async () => {
    const response = await api.get('/playlists');
    setPlaylists(response.data.data || []);
  };

  const createPlaylist = async (event: React.FormEvent) => {
    event.preventDefault();
    setPlaylistError('');
    try {
      const response = await api.post('/playlists', { name: newPlaylistName.trim() });
      setNewPlaylistName('');
      await refreshPlaylists();
      setOpenPlaylistId(response.data.data.id);
      setPlaylistStatus('Playlist created. Add tracks from Library.');
    } catch (error: any) {
      setPlaylistError(error.response?.data?.detail || 'Could not create playlist.');
    }
  };

  const addToPlaylist = async (playlistId: number, track: Track) => {
    setPlaylistError('');
    try {
      await api.post(`/playlists/${playlistId}/tracks`, { file_path: track.file_path });
      await refreshPlaylists();
      setPlaylistStatus(`Added to ${playlists.find((playlist) => playlist.id === playlistId)?.name || 'playlist'}.`);
    } catch (error: any) {
      setPlaylistError(error.response?.data?.detail || 'Could not add track to playlist.');
    }
  };

  const removeFromPlaylist = async (playlistId: number, entryId: number) => {
    try {
      await api.delete(`/playlists/${playlistId}/tracks/${entryId}`);
      await refreshPlaylists();
    } catch {
      setPlaylistError('Could not remove track from playlist. Please try again.');
    }
  };

  const deletePlaylist = async (playlistId: number) => {
    if (!window.confirm('Delete this playlist? Your music files will stay on disk.')) return;
    try {
      await api.delete(`/playlists/${playlistId}`);
      setOpenPlaylistId(null);
      await refreshPlaylists();
    } catch {
      setPlaylistError('Could not delete playlist. Please try again.');
    }
  };

  const renamePlaylist = async (event: React.FormEvent, playlistId: number) => {
    event.preventDefault();
    setPlaylistError('');
    try {
      await api.patch(`/playlists/${playlistId}`, { name: editedPlaylistName.trim() });
      setRenamingPlaylistId(null);
      await refreshPlaylists();
      setPlaylistStatus('Playlist renamed.');
    } catch (error: any) {
      setPlaylistError(error.response?.data?.detail || 'Could not rename playlist.');
    }
  };

  const movePlaylistTrack = async (playlistId: number, entryId: number, position: number) => {
    try {
      await api.patch(`/playlists/${playlistId}/tracks/${entryId}`, { position });
      await refreshPlaylists();
    } catch {
      setPlaylistError('Could not reorder playlist. Please try again.');
    }
  };

  const queueNext = (track: Track) => {
    addPlayNext(track);
    setPlaylistStatus(`${track.title || 'Track'} will play next.`);
  };

  const queueLast = (track: Track) => {
    addToPlaybackEnd(track);
    setPlaylistStatus(`${track.title || 'Track'} added to Up Next.`);
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

  const openPlaylist = playlists.find((playlist) => playlist.id === openPlaylistId);
  if (openPlaylist) {
    const playable = openPlaylist.tracks.flatMap((entry) => entry.track ? [entry.track] : []);
    return (
      <div className="animate-rise-in space-y-6 pt-2">
        <button onClick={() => setOpenPlaylistId(null)} className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-100"><ArrowLeft size={17} /> Playlists</button>
        {playlistError && <p role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{playlistError}</p>}
        {playlistStatus && <p role="status" className="text-xs text-audora-300">{playlistStatus}</p>}
        <div className="flex items-end gap-5">
          <div className="flex h-40 w-40 shrink-0 items-center justify-center rounded-2xl border border-white/[0.1] bg-white/[0.04] text-audora-400"><ListPlus size={42} /></div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs uppercase tracking-[0.18em] text-audora-400">Playlist</p>
            {renamingPlaylistId === openPlaylist.id ? (
              <form onSubmit={(event) => void renamePlaylist(event, openPlaylist.id)} className="flex items-center gap-2">
                <input value={editedPlaylistName} onChange={(event) => setEditedPlaylistName(event.target.value)} maxLength={100} autoFocus aria-label="Playlist name" className="min-w-0 rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-xl text-white outline-none focus:border-audora-400" />
                <button type="submit" disabled={!editedPlaylistName.trim()} aria-label="Save playlist name" className="p-1.5 text-audora-300 disabled:opacity-40"><Check size={18} /></button>
                <button type="button" onClick={() => setRenamingPlaylistId(null)} aria-label="Cancel rename" className="p-1.5 text-gray-400"><X size={18} /></button>
              </form>
            ) : (
              <div className="flex items-center gap-2"><h1 className="break-words text-3xl font-semibold">{openPlaylist.name}</h1><button onClick={() => { setEditedPlaylistName(openPlaylist.name); setRenamingPlaylistId(openPlaylist.id); }} aria-label="Rename playlist" className="p-1.5 text-gray-500 hover:text-gray-200"><Pencil size={15} /></button></div>
            )}
            <p className="mt-1 text-xs text-gray-500">{openPlaylist.tracks.length} tracks · References to your library files</p>
            <button onClick={() => playTracks(playable)} disabled={!playable.length} className="mt-4 flex items-center gap-2 rounded-full bg-audora-500 px-5 py-2 text-sm text-white disabled:opacity-40"><Play size={15} fill="currentColor" /> Play playlist</button>
          </div>
          <button onClick={() => void deletePlaylist(openPlaylist.id)} aria-label={`Delete playlist ${openPlaylist.name}`} title="Delete playlist; music files stay on disk" className="rounded-full p-2 text-gray-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={17} /></button>
        </div>
        <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
          {openPlaylist.tracks.map((entry, index) => (
            <div key={entry.entry_id} className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3 last:border-b-0">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-gray-500">{index + 1}</span>
              <button disabled={!entry.track} onClick={() => entry.track && playTracks(playable, entry.track)} className="min-w-0 flex-1 text-left disabled:opacity-50">
                <span className="block truncate text-sm text-gray-100">{entry.track?.title || entry.file_path.split(/[\\/]/).pop()}</span>
                <span className="block truncate text-xs text-gray-500">{entry.track?.artist || 'File missing from library'}</span>
              </button>
              {entry.track && <TrackActions track={entry.track} playlists={playlists} onPlayNext={queueNext} onQueueLast={queueLast} onAddToPlaylist={addToPlaylist} />}
              <button onClick={() => void movePlaylistTrack(openPlaylist.id, entry.entry_id, index - 1)} disabled={index === 0} aria-label={`Move ${entry.track?.title || 'track'} up`} className="p-1 text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowUp size={14} /></button>
              <button onClick={() => void movePlaylistTrack(openPlaylist.id, entry.entry_id, index + 1)} disabled={index === openPlaylist.tracks.length - 1} aria-label={`Move ${entry.track?.title || 'track'} down`} className="p-1 text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowDown size={14} /></button>
              <button onClick={() => void removeFromPlaylist(openPlaylist.id, entry.entry_id)} title="Remove from playlist; keep music file" aria-label={`Remove ${entry.track?.title || 'track'} from playlist`} className="p-1.5 text-gray-500 hover:text-rose-300"><Trash2 size={15} /></button>
            </div>
          ))}
          {!openPlaylist.tracks.length && <p className="px-4 py-5 text-sm text-gray-500">This playlist is empty. Add tracks from Library.</p>}
        </div>
      </div>
    );
  }

  const openAlbum = albums.find((album) => album.folder_path === openAlbumPath);
  if (openAlbum) {
    const albumTracks = [...openAlbum.tracks].sort((first, second) =>
      naturalName.compare(first.file_path, second.file_path)
    );
    return (
      <div className="animate-rise-in space-y-8 pt-2">
        <button
          onClick={() => setOpenAlbumPath(null)}
          className="flex items-center gap-2 text-sm text-gray-400 transition-colors hover:text-gray-100"
        >
          <ArrowLeft size={17} /> Albums
        </button>
        {playlistError && <p role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{playlistError}</p>}
        {playlistStatus && <p role="status" className="text-xs text-audora-300">{playlistStatus}</p>}
        <div className="flex flex-wrap items-end gap-7">
          <div className="aspect-square w-56 max-w-full shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] shadow-glass">
            <AlbumArt trackId={albumTracks[0]?.id} />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-audora-400">Album</p>
            <h1 className="break-words text-3xl font-semibold tracking-tight text-gray-100">{openAlbum.album || 'Unknown album'}</h1>
            <p className="mt-2 text-sm text-gray-400">{openAlbum.artist || 'Unknown artist'}</p>
            <p className="mt-1 text-xs text-gray-500">{albumTracks.length} tracks</p>
            <button
              onClick={() => playTracks(albumTracks)}
              disabled={!albumTracks.length}
              className="mt-5 flex items-center gap-2 rounded-full bg-audora-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-audora-400 disabled:opacity-40"
            >
              <Play size={16} fill="currentColor" /> Play album
            </button>
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
          {albumTracks.map((track, index) => (
            <div
              key={track.file_path}
              className="group flex w-full min-w-0 items-center gap-4 border-b border-white/[0.06] px-4 py-3 last:border-b-0 hover:bg-white/[0.06]"
            >
              <span className="w-6 shrink-0 text-right font-mono text-xs text-gray-500">{index + 1}</span>
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg">
                <AlbumArt trackId={track.id} size={16} />
              </div>
              <button onClick={() => playTracks(albumTracks, track)} aria-label={`Play ${track.title || `track ${index + 1}`}`} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium text-gray-100">{track.title || 'Unknown track'}</span>
                <span className="block truncate text-xs text-gray-500">{track.artist || openAlbum.artist}</span>
              </button>
              <span className="shrink-0 font-mono text-xs text-gray-500">{formatDuration(track.duration)}</span>
              <TrackActions track={track} playlists={playlists} onPlayNext={queueNext} onQueueLast={queueLast} onAddToPlaylist={addToPlaylist} />
            </div>
          ))}
        </div>
      </div>
    );
  }

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

      {playlistError && <p role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{playlistError}</p>}
      {playlistStatus && <p role="status" className="text-xs text-audora-300">{playlistStatus}</p>}

      {tab === 'playlists' ? (
        <div className="space-y-5">
          <form onSubmit={createPlaylist} className="flex max-w-lg gap-2">
            <input value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} maxLength={100} placeholder="New playlist name" aria-label="New playlist name" className="min-w-0 flex-1 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-2 text-sm text-gray-100 outline-none focus:border-audora-400" />
            <button type="submit" disabled={!newPlaylistName.trim()} className="flex items-center gap-2 rounded-xl bg-audora-500 px-4 py-2 text-sm text-white disabled:opacity-40"><Plus size={16} /> Create</button>
          </form>
          {playlists.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
            {playlists.filter((playlist) => playlist.name.toLowerCase().includes(needle)).map((playlist) => (
              <button key={playlist.id} onClick={() => setOpenPlaylistId(playlist.id)} className="glass glass-hover group rounded-2xl p-4 text-left">
                <div className="relative z-10 mb-4 aspect-square overflow-hidden rounded-xl bg-white/[0.04] text-audora-400"><AlbumArt trackId={playlist.tracks.find((entry) => entry.track?.id)?.track?.id} size={38} /></div>
                <p className="relative z-10 truncate text-sm font-medium text-gray-100">{playlist.name}</p>
                <p className="relative z-10 text-xs text-gray-500">{playlist.tracks.length} tracks</p>
              </button>
            ))}
          </div> : <p className="text-sm text-gray-500">Create a playlist, then add tracks from Library. Your music files stay in place.</p>}
        </div>
      ) : tracks.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing here yet. Download an album and it will appear once scanned.
        </p>
      ) : tab === 'tracks' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
          {filtered.map((track) => (
            <div
              key={track.file_path}
              className="group min-w-0 max-w-[18rem] text-left"
            >
              <button onClick={() => playTracks(filtered, track)} className="block w-full text-left" aria-label={`Play ${track.title || 'track'}`}>
                <ArtworkTile trackId={track.id} />
                <p className="truncate text-sm font-medium text-gray-100">{track.title}</p>
                <p className="truncate text-xs text-gray-500">{track.artist}</p>
              </button>
              <div className="mt-1 flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] tabular-nums text-gray-600">{formatDuration(track.duration)}</span>
                <TrackActions track={track} playlists={playlists} onPlayNext={queueNext} onQueueLast={queueLast} onAddToPlaylist={addToPlaylist} />
              </div>
            </div>
          ))}
        </div>
      ) : tab === 'artists' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
          {albums
            .filter((album) => (album.album || '').toLowerCase().includes(needle))
            .map((album) => (
              <button
                key={album.folder_path}
                onClick={() => setOpenAlbumPath(album.folder_path)}
                aria-label={`Open ${album.album || 'Unknown album'}`}
                className="group min-w-0 max-w-[18rem] text-left"
              >
                <ArtworkTile trackId={album.tracks[0]?.id} showPlay={false} />
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
