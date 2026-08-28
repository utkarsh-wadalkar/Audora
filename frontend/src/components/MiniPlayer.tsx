import { useEffect, useRef, useState } from 'react';
import { Howl } from 'howler';
import { Play, Pause, SkipBack, SkipForward, Volume2, Music } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { API_BASE } from '../api/client';
import { formatDuration } from '../lib/format';

export default function MiniPlayer() {
  const currentTrack = useAppStore((s) => s.currentTrack);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackQueue = useAppStore((s) => s.playbackQueue);
  const setIsPlaying = useAppStore((s) => s.setIsPlaying);
  const playNext = useAppStore((s) => s.playNext);
  const playPrevious = useAppStore((s) => s.playPrevious);

  const howlRef = useRef<Howl | null>(null);
  const rafRef = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);

  // (Re)load the Howl instance when the track changes.
  useEffect(() => {
    howlRef.current?.unload();
    howlRef.current = null;
    setPosition(0);
    setDuration(0);

    if (!currentTrack?.id) return;

    const howl = new Howl({
      src: [`${API_BASE}/library/stream/${currentTrack.id}`],
      // FLAC is the only format Audora produces. It is also the reason the
      // library is FLAC-only: Chromium has no ALAC decoder, so the previous
      // .m4a downloads were fetched fine and then silently failed to decode.
      format: ['flac'],
      html5: true, // stream instead of fully buffering
      volume,
      onload: () => setDuration(howl.duration()),
      // Read the current store action instead of closing over the queue from
      // this render. Howler invokes this callback long after the effect ran.
      onend: () => useAppStore.getState().playNext(),
    });
    howlRef.current = howl;
    howl.play();
    setIsPlaying(true);

    return () => {
      howl.unload();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id]);

  // Reflect play/pause state onto the Howl.
  useEffect(() => {
    const howl = howlRef.current;
    if (!howl) return;
    if (isPlaying && !howl.playing()) howl.play();
    if (!isPlaying && howl.playing()) howl.pause();
  }, [isPlaying]);

  // Track playback position via requestAnimationFrame while playing.
  useEffect(() => {
    const tick = () => {
      const howl = howlRef.current;
      if (howl && howl.playing()) {
        setPosition(howl.seek() as number);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const togglePlay = () => {
    if (!currentTrack) return;
    setIsPlaying(!isPlaying);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const howl = howlRef.current;
    if (!howl || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    howl.seek(ratio * duration);
    setPosition(ratio * duration);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    howlRef.current?.volume(v);
  };

  const progressPct = duration ? (position / duration) * 100 : 0;
  const currentIndex = currentTrack
    ? playbackQueue.findIndex((track) =>
        track.id != null && currentTrack.id != null
          ? track.id === currentTrack.id
          : track.file_path === currentTrack.file_path
      )
    : -1;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < playbackQueue.length - 1;

  return (
    <div className="glass mx-6 mb-3 flex h-[72px] shrink-0 items-center gap-5 rounded-2xl px-4">
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04] text-gray-600">
          {currentTrack?.id ? (
            <img
              key={currentTrack.id}
              src={`${API_BASE}/library/art/${currentTrack.id}`}
              alt=""
              className="h-full w-full object-cover"
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : (
            <Music size={18} />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-100">
            {currentTrack?.title || 'Nothing playing'}
          </p>
          <p className="truncate text-xs text-gray-500">
            {currentTrack?.artist || 'Pick a track from your library'}
          </p>
        </div>
      </div>

      <div className="relative z-10 flex w-[26rem] flex-col items-center gap-1.5">
        <div className="flex items-center gap-4">
          <button
            onClick={playPrevious}
            className="text-gray-500 transition-colors hover:text-gray-200 disabled:opacity-30"
            disabled={!hasPrevious}
            aria-label="Previous track"
          >
            <SkipBack size={17} />
          </button>
          <button
            onClick={togglePlay}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-audora-500 text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-95 disabled:opacity-40"
            disabled={!currentTrack}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" className="ml-0.5" />
            )}
          </button>
          <button
            onClick={playNext}
            className="text-gray-500 transition-colors hover:text-gray-200 disabled:opacity-30"
            disabled={!hasNext}
            aria-label="Next track"
          >
            <SkipForward size={17} />
          </button>
        </div>
        <div className="flex w-full items-center gap-2.5 font-mono text-[10px] tabular-nums text-gray-500">
          <span>{formatDuration(position)}</span>
          <div
            className="group/seek relative h-1 flex-1 cursor-pointer rounded-full bg-white/[0.09]"
            onClick={seek}
          >
            <div
              className="h-full rounded-full bg-audora-400 transition-[width] duration-150 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="relative z-10 flex w-32 items-center gap-2">
        <Volume2 size={14} className="shrink-0 text-gray-500" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => changeVolume(parseFloat(e.target.value))}
          className="flex-1 accent-audora-400"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
