import { useEffect, useRef, useState } from 'react';
import { Howl } from 'howler';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music, Shuffle, Repeat, Repeat1, ListMusic, X, ArrowUp, ArrowDown } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { API_BASE } from '../api/client';
import { formatDuration } from '../lib/format';

export default function MiniPlayer() {
  const currentTrack = useAppStore((s) => s.currentTrack);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackQueue = useAppStore((s) => s.playbackQueue);
  const playbackIndex = useAppStore((s) => s.playbackIndex);
  const playbackRequestId = useAppStore((s) => s.playbackRequestId);
  const shuffleEnabled = useAppStore((s) => s.shuffleEnabled);
  const repeatMode = useAppStore((s) => s.repeatMode);
  const setIsPlaying = useAppStore((s) => s.setIsPlaying);
  const playNext = useAppStore((s) => s.playNext);
  const playPrevious = useAppStore((s) => s.playPrevious);
  const toggleShuffle = useAppStore((s) => s.toggleShuffle);
  const cycleRepeat = useAppStore((s) => s.cycleRepeat);
  const removeUpcoming = useAppStore((s) => s.removeUpcoming);
  const moveUpcoming = useAppStore((s) => s.moveUpcoming);
  const clearUpcoming = useAppStore((s) => s.clearUpcoming);
  const playQueueIndex = useAppStore((s) => s.playQueueIndex);

  const howlRef = useRef<Howl | null>(null);
  const rafRef = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [showUpNext, setShowUpNext] = useState(false);
  const lastVolumeRef = useRef(0.8);

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
      onend: () => {
        const before = useAppStore.getState().currentTrack?.id;
        const continued = useAppStore.getState().finishTrack();
        if (continued && useAppStore.getState().currentTrack?.id === before) {
          howl.seek(0);
          howl.play();
        }
      },
    });
    howlRef.current = howl;
    howl.play();
    setIsPlaying(true);

    return () => {
      howl.unload();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, playbackRequestId]);

  // Reflect play/pause state onto the Howl.
  useEffect(() => {
    const howl = howlRef.current;
    if (!howl) return;
    if (isPlaying && !howl.playing()) {
      if (duration && position >= duration - 0.1) howl.seek(0);
      howl.play();
    }
    if (!isPlaying && howl.playing()) howl.pause();
  }, [isPlaying]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || target?.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName || '')) return;
      const howl = howlRef.current;
      if (event.code === 'Space' && currentTrack) {
        event.preventDefault();
        setIsPlaying(!useAppStore.getState().isPlaying);
      } else if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && howl && Number.isFinite(howl.duration()) && howl.duration() > 0) {
        event.preventDefault();
        const offset = event.code === 'ArrowRight' ? 5 : -5;
        const next = Math.max(0, Math.min(howl.duration(), (howl.seek() as number) + offset));
        howl.seek(next);
        setPosition(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentTrack, setIsPlaying]);

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
    if (v > 0) lastVolumeRef.current = v;
  };

  const toggleMute = () => changeVolume(volume > 0 ? 0 : lastVolumeRef.current);

  const goPrevious = () => {
    if (position > 3 || playbackIndex === 0) {
      howlRef.current?.seek(0);
      setPosition(0);
    } else playPrevious();
  };

  const goNext = () => {
    const before = useAppStore.getState().currentTrack?.id;
    if (playNext() && useAppStore.getState().currentTrack?.id === before) {
      howlRef.current?.seek(0);
      setPosition(0);
      howlRef.current?.play();
    }
  };

  const progressPct = duration ? (position / duration) * 100 : 0;
  const hasPrevious = playbackIndex > 0 || !!currentTrack;
  const hasNext = playbackIndex >= 0 && (playbackIndex < playbackQueue.length - 1 || repeatMode === 'all');

  return (
    <div className="glass relative mx-6 mb-3 flex h-[72px] shrink-0 items-center gap-5 rounded-2xl px-4">
      {showUpNext && (
        <div className="absolute bottom-[78px] right-3 z-30 max-h-80 w-80 overflow-y-auto rounded-2xl border border-white/[0.12] bg-[#1b1a22] p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between px-1 text-sm font-medium text-gray-100">
            <span>Up Next</span>
            <div className="flex items-center gap-2">
              <button onClick={clearUpcoming} disabled={playbackIndex >= playbackQueue.length - 1} className="text-xs text-gray-500 hover:text-gray-200 disabled:opacity-40">Clear</button>
              <button onClick={() => setShowUpNext(false)} aria-label="Close Up Next" className="text-gray-400 hover:text-white"><X size={16} /></button>
            </div>
          </div>
          {playbackQueue.slice(playbackIndex + 1).length ? playbackQueue.slice(playbackIndex + 1).map((track, offset) => (
            <div key={`${track.file_path}-${offset}`} className="flex items-center gap-2 border-t border-white/[0.06] py-2">
              <button onClick={() => playQueueIndex(playbackIndex + offset + 1)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs text-gray-100">{track.title || 'Unknown track'}</span>
                <span className="block truncate text-[11px] text-gray-500">{track.artist || 'Unknown artist'}</span>
              </button>
              <button onClick={() => moveUpcoming(playbackIndex + offset + 1, playbackIndex + offset)} disabled={offset === 0} aria-label={`Move ${track.title || 'track'} up`} className="text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowUp size={13} /></button>
              <button onClick={() => moveUpcoming(playbackIndex + offset + 1, playbackIndex + offset + 2)} disabled={offset === playbackQueue.length - playbackIndex - 2} aria-label={`Move ${track.title || 'track'} down`} className="text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowDown size={13} /></button>
              <button onClick={() => removeUpcoming(playbackIndex + offset + 1)} aria-label={`Remove ${track.title || 'track'} from Up Next`} className="text-gray-500 hover:text-gray-200"><X size={14} /></button>
            </div>
          )) : <p className="px-1 py-3 text-xs text-gray-500">Nothing lined up. Add a track from Library.</p>}
        </div>
      )}
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
        <div className="flex items-center gap-3">
          <button onClick={toggleShuffle} disabled={!currentTrack} title={shuffleEnabled ? 'Shuffle on' : 'Shuffle off'} aria-label={shuffleEnabled ? 'Turn shuffle off' : 'Turn shuffle on'} aria-pressed={shuffleEnabled} className={`transition-colors disabled:opacity-30 ${shuffleEnabled ? 'text-audora-400' : 'text-gray-500 hover:text-gray-200'}`}><Shuffle size={16} /></button>
          <button
            onClick={goPrevious}
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
            onClick={goNext}
            className="text-gray-500 transition-colors hover:text-gray-200 disabled:opacity-30"
            disabled={!hasNext}
            aria-label="Next track"
          >
            <SkipForward size={17} />
          </button>
          <button onClick={cycleRepeat} disabled={!currentTrack} title={`Repeat ${repeatMode}`} aria-label={`Repeat ${repeatMode}. Change repeat mode`} className={`transition-colors disabled:opacity-30 ${repeatMode === 'off' ? 'text-gray-500 hover:text-gray-200' : 'text-audora-400'}`}>
            {repeatMode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </button>
          <button onClick={() => setShowUpNext((open) => !open)} title="Up Next" aria-label="Show Up Next" aria-expanded={showUpNext} className={showUpNext ? 'text-audora-400' : 'text-gray-500 hover:text-gray-200'}><ListMusic size={16} /></button>
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

      <div className="relative z-10 flex w-32 shrink-0 items-center gap-2">
        <button onClick={toggleMute} aria-label={volume ? 'Mute' : 'Unmute'} className="shrink-0 text-gray-500 hover:text-gray-200">
          {volume ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => changeVolume(parseFloat(e.target.value))}
          className="min-w-0 flex-1 accent-audora-400"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
