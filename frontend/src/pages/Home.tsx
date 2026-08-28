import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Music, Play, Search, RotateCw, Heart } from 'lucide-react';
import { api, API_BASE } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import type { Track } from '../store/useAppStore';
import { formatDuration, formatSize } from '../lib/format';

interface AlbumGroup {
  folder_path: string;
  artist?: string;
  album?: string;
  tracks: Track[];
}

/** Square album art with a graceful fallback when a track has no embedded image. */
function AlbumArt({ trackId, size = 18 }: { trackId?: number; size?: number }) {
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

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<AlbumGroup[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<any[]>([]);
  const [query, setQuery] = useState('');

  const playTracks = useAppStore((s) => s.playTracks);
  const currentTrack = useAppStore((s) => s.currentTrack);

  useEffect(() => {
    api
      .get('/library')
      .then((response) => setTracks(response.data.data || []))
      .catch(() => {});
    api
      .get('/library/albums')
      .then((response) => setAlbums(response.data.data || []))
      .catch(() => {});
    api
      .get('/history')
      .then((response) => setDownloadJobs((response.data.data || []).slice(0, 6)))
      .catch(() => {});
  }, []);

  const librarySize = useMemo(
    () => tracks.reduce((total, track) => total + (track.file_size || 0), 0),
    [tracks]
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return tracks
      .filter((track) =>
        [track.title, track.artist, track.album]
          .some((field) => (field || '').toLowerCase().includes(needle))
      )
      .slice(0, 8);
  }, [tracks, query]);

  // "Next up" is the tail of the library after whatever is playing — a real
  // continuation, not a shuffled sample.
  const nextUp = useMemo(() => {
    const playingIndex = currentTrack
      ? tracks.findIndex((track) => track.id === currentTrack.id)
      : -1;
    return tracks.slice(playingIndex + 1, playingIndex + 7);
  }, [tracks, currentTrack]);

  const retryJob = async (jobId: number) => {
    await api.post(`/history/${jobId}/retry`);
  };

  return (
    <div className="animate-rise-in space-y-10 pt-2">
      <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
        <Search size={16} className="relative z-10 shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your library by title, artist or album"
          className="relative z-10 w-full bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
        />
        {tracks.length > 0 && (
          <span className="relative z-10 shrink-0 font-mono text-[11px] tabular-nums text-gray-500">
            {tracks.length} tracks · {formatSize(librarySize)}
          </span>
        )}
      </div>

      {matches.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400">Search results</h2>
          <div className="glass overflow-hidden rounded-2xl">
            {matches.map((track, index) => (
              <button
                key={track.file_path}
                onClick={() => playTracks(matches, track)}
                className={`relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.05] ${
                  index > 0 ? 'border-t border-white/[0.05]' : ''
                }`}
              >
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
                  <AlbumArt trackId={track.id} size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-100">{track.title}</p>
                  <p className="truncate text-xs text-gray-500">{track.artist}</p>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-gray-500">
                  {formatDuration(track.duration)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {albums.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-gray-100">
              Your albums
            </h2>
            <Link
              to="/library"
              className="text-xs text-gray-500 transition-colors hover:text-audora-300"
            >
              Open library
            </Link>
          </div>
          <div className="scrollbar-none rail-fade -mx-2 flex gap-4 overflow-x-auto px-2 pb-2">
            {albums.map((album) => {
              const firstTrack = album.tracks[0];
              if (!firstTrack) return null;
              return (
                <button
                  key={album.folder_path}
                  onClick={() => playTracks(album.tracks, firstTrack)}
                  className="group w-44 shrink-0 text-left"
                >
                  <div className="relative mb-3 aspect-square overflow-hidden rounded-xl border border-white/[0.08] shadow-glass">
                    <AlbumArt trackId={firstTrack.id} size={28} />
                    <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-audora-500 text-white shadow-knob">
                        <Play size={15} fill="currentColor" className="ml-0.5" />
                      </span>
                    </div>
                  </div>
                  <p className="truncate text-sm font-medium text-gray-100">
                    {album.album || 'Unknown album'}
                  </p>
                  <p className="truncate text-xs text-gray-500">{album.artist}</p>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid grid-cols-2 gap-6">
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-gray-100">
            Next up
          </h2>
          {nextUp.length === 0 ? (
            <p className="text-sm text-gray-500">
              {tracks.length === 0 ? (
                <>
                  Nothing here yet.{' '}
                  <Link to="/download" className="text-audora-300 hover:text-audora-200">
                    Download an album
                  </Link>{' '}
                  to get started.
                </>
              ) : (
                'End of your library. Pick another track to keep going.'
              )}
            </p>
          ) : (
            <div className="glass overflow-hidden rounded-2xl">
              {nextUp.map((track, index) => (
                <div
                  key={track.file_path}
                  className={`group relative z-10 flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.05] ${
                    index > 0 ? 'border-t border-white/[0.05]' : ''
                  }`}
                >
                  <button
                    onClick={() => playTracks(tracks, track)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg">
                      <AlbumArt trackId={track.id} size={14} />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
                        <Play size={13} fill="currentColor" className="text-white" />
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-gray-100">{track.title}</p>
                      <p className="truncate text-xs text-gray-500">
                        {track.artist}
                        {track.album ? ` — ${track.album}` : ''}
                      </p>
                    </div>
                  </button>
                  <span className="font-mono text-[11px] tabular-nums text-gray-500">
                    {formatDuration(track.duration)}
                  </span>
                  <Heart
                    size={14}
                    className="shrink-0 text-gray-600 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-gray-100">History</h2>
            <Link
              to="/history"
              className="text-xs text-gray-500 transition-colors hover:text-audora-300"
            >
              See all
            </Link>
          </div>
          {downloadJobs.length === 0 ? (
            <p className="text-sm text-gray-500">
              No downloads yet.{' '}
              <Link to="/download" className="text-audora-300 hover:text-audora-200">
                Start one
              </Link>
              .
            </p>
          ) : (
            <div className="glass overflow-hidden rounded-2xl">
              {downloadJobs.map((job, index) => (
                <div
                  key={job.id}
                  className={`relative z-10 flex items-center gap-3 px-4 py-2.5 ${
                    index > 0 ? 'border-t border-white/[0.05]' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-100">{job.title || job.url}</p>
                    <p className="text-xs text-gray-500">
                      {job.track_count || 0} tracks
                      {job.error_count ? ` · ${job.error_count} failed` : ''}
                    </p>
                  </div>
                  <StatusPill status={job.status} />
                  <button
                    onClick={() => retryJob(job.id)}
                    title="Download again"
                    aria-label="Download again"
                    className="shrink-0 rounded text-gray-600 transition-colors hover:text-audora-300"
                  >
                    <RotateCw size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status?: string }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-500/12 text-emerald-300'
      : status === 'cancelled'
      ? 'bg-white/[0.06] text-gray-400'
      : 'bg-rose-500/12 text-rose-300';

  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {status || 'unknown'}
    </span>
  );
}
