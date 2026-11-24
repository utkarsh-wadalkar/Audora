import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Shuffle, Repeat, Repeat1, ListMusic, X, ArrowUp, ArrowDown, Heart, Mic2, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { api, API_BASE } from '../api/client';
import { formatDuration } from '../lib/format';
import { audioEngine, readAudioSettings } from '../lib/audioEngine';
import { useNavigate } from 'react-router-dom';
import { parseLrc } from '../lib/lyrics';
import TrackArtwork from './TrackArtwork';

export default function MiniPlayer() {
  const navigate = useNavigate();
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

  const crossfadePending = useRef(false);
  const rafRef = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [showUpNext, setShowUpNext] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [lyricsSynced, setLyricsSynced] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [audioError, setAudioError] = useState('');
  const lastVolumeRef = useRef(0.8);
  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const timedLyrics = useMemo(() => lyricsSynced ? parseLrc(lyrics) : [], [lyrics, lyricsSynced]);
  const activeLyric = timedLyrics.reduce((active, line, index) => line.seconds <= position ? index : active, -1);

  useEffect(() => {
    if (showLyrics && activeLyric >= 0) lyricsScrollRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeLyric, showLyrics]);

  useEffect(() => {
    audioEngine.onMetadata = setDuration;
    audioEngine.onError = (message) => { setAudioError(message); setIsPlaying(false); };
    audioEngine.onEnded = () => {
      const before = useAppStore.getState().currentTrack?.id;
      const continued = useAppStore.getState().finishTrack();
      if (continued && useAppStore.getState().currentTrack?.id === before) {
        audioEngine.seek(0);
        void audioEngine.play();
      }
    };
    audioEngine.onNearEnd = () => {
      const state = useAppStore.getState();
      if (!state.isPlaying || state.repeatMode === 'one') return false;
      const next = state.playbackQueue[state.playbackIndex + 1] ??
        (state.repeatMode === 'all' ? state.playbackQueue[0] : null);
      if (!next || next.id === state.currentTrack?.id) return false;
      crossfadePending.current = true;
      state.finishTrack();
      return true;
    };
    const onSettings = () => audioEngine.applySettings();
    window.addEventListener('audora-audio-settings', onSettings);
    return () => { window.removeEventListener('audora-audio-settings', onSettings); audioEngine.dispose(); };
  }, [setIsPlaying]);

  // Load a new stream. A natural queue transition may overlap both streams.
  useEffect(() => {
    setPosition(0);
    setDuration(0);
    setAudioError('');

    if (!currentTrack?.id) { audioEngine.pause(); return; }
    audioEngine.load(`${API_BASE}/library/stream/${currentTrack.id}`,
      crossfadePending.current ? Math.min(readAudioSettings().crossfadeSeconds,
        Math.max(0.1, audioEngine.duration - audioEngine.position)) : 0);
    crossfadePending.current = false;
    audioEngine.setVolume(volume);
    setIsPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, playbackRequestId]);

  // Reflect play/pause state onto the audio engine.
  useEffect(() => {
    if (isPlaying && !audioEngine.playing) {
      if (duration && position >= duration - 0.1) audioEngine.seek(0);
      void audioEngine.play();
    }
    if (!isPlaying && audioEngine.playing) audioEngine.pause();
  }, [isPlaying]);

  useEffect(() => {
    let cancelled = false;
    setLyrics(''); setLyricsSynced(false);
    if (!currentTrack?.id) { setLyricsLoading(false); return; }
    setLyricsLoading(true);
    void api.get(`/library/lyrics/${currentTrack.id}`)
      .then((lyricsResponse) => {
        if (cancelled) return;
        setLyrics(lyricsResponse.data.data?.text || '');
        setLyricsSynced(!!lyricsResponse.data.data?.synced);
      })
      .catch(() => { if (!cancelled) setLyrics(''); })
      .finally(() => { if (!cancelled) setLyricsLoading(false); });
    return () => { cancelled = true; };
  }, [currentTrack?.id, currentTrack?.file_path]);

  useEffect(() => {
    let cancelled = false;
    setFavorite(false);
    const refreshFavorite = () => {
      void api.get('/library/favorites').then((response) => {
        if (!cancelled) setFavorite(Array.isArray(response.data.data) && response.data.data.includes(currentTrack?.file_path));
      }).catch(() => {});
    };
    refreshFavorite();
    window.addEventListener('audora-favorites-changed', refreshFavorite);
    return () => { cancelled = true; window.removeEventListener('audora-favorites-changed', refreshFavorite); };
  }, [currentTrack?.file_path]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || target?.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName || '')) return;
      if (event.code === 'Space' && currentTrack) {
        event.preventDefault();
        setIsPlaying(!useAppStore.getState().isPlaying);
      } else if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && Number.isFinite(audioEngine.duration) && audioEngine.duration > 0) {
        event.preventDefault();
        const offset = event.code === 'ArrowRight' ? 5 : -5;
        const next = Math.max(0, Math.min(audioEngine.duration, audioEngine.position + offset));
        audioEngine.seek(next);
        setPosition(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentTrack, setIsPlaying]);

  // Track playback position via requestAnimationFrame while playing.
  useEffect(() => {
    const tick = () => {
      if (audioEngine.playing) {
        setPosition(audioEngine.position);
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
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioEngine.seek(ratio * duration);
    setPosition(ratio * duration);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    audioEngine.setVolume(v);
    if (v > 0) lastVolumeRef.current = v;
  };

  const toggleMute = () => changeVolume(volume > 0 ? 0 : lastVolumeRef.current);

  const goPrevious = () => {
    if (position > 3 || playbackIndex === 0) {
      audioEngine.seek(0);
      setPosition(0);
    } else playPrevious();
  };

  const goNext = () => {
    const before = useAppStore.getState().currentTrack?.id;
    if (playNext() && useAppStore.getState().currentTrack?.id === before) {
      audioEngine.seek(0);
      setPosition(0);
      void audioEngine.play();
    }
  };

  const progressPct = duration ? (position / duration) * 100 : 0;
  const hasPrevious = playbackIndex > 0 || !!currentTrack;
  const hasNext = playbackIndex >= 0 && (playbackIndex < playbackQueue.length - 1 || repeatMode === 'all');

  const toggleFavorite = async () => {
    if (!currentTrack?.id) return;
    try {
      if (favorite) await api.delete(`/library/favorites/${currentTrack.id}`);
      else await api.put(`/library/favorites/${currentTrack.id}`);
      setFavorite(!favorite);
      window.dispatchEvent(new Event('audora-favorites-changed'));
    } catch { setAudioError('Could not update favorites. Please try again.'); }
  };

  return (
    <div className="glass relative mx-6 mb-3 flex h-[72px] shrink-0 items-center gap-5 rounded-2xl px-4">
      {audioError && <p role="alert" className="absolute bottom-[78px] left-3 z-30 max-w-sm rounded-xl border border-rose-500/20 bg-[#241b22] px-3 py-2 text-xs text-rose-300">{audioError}</p>}
      {showLyrics && (
        <div className="absolute bottom-[78px] right-3 z-30 flex max-h-[65vh] w-[min(26rem,90vw)] flex-col rounded-2xl border border-white/[0.12] bg-[#1b1a22] p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium text-gray-100">Lyrics · {currentTrack?.title || 'No track'}</span><button onClick={() => setShowLyrics(false)} aria-label="Close lyrics" className="text-gray-400 hover:text-white"><X size={16} /></button></div>
          <div ref={lyricsScrollRef} className="scrollbar-lyrics min-h-0 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed text-gray-300">{lyricsLoading ? 'Loading lyrics…' : timedLyrics.length ? timedLyrics.map((line, index) => <button key={`${line.seconds}-${index}`} data-active={index === activeLyric} onClick={() => audioEngine.seek(line.seconds)} className={`block w-full rounded px-1 py-1 text-left transition-colors ${index === activeLyric ? 'text-audora-300' : 'text-gray-400 hover:text-gray-100'}`}>{line.text || '♪'}</button>) : lyrics || 'No lyrics were found in this track or a matching .lrc/.txt file.'}</div>
        </div>
      )}
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
          <TrackArtwork track={currentTrack} size={18} eager />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-100">
            {currentTrack?.title || 'Nothing playing'}
          </p>
          <p className="truncate text-xs text-gray-500">
            {currentTrack?.artist || 'Pick a track from your library'}
          </p>
        </div>
        <button onClick={() => void toggleFavorite()} disabled={!currentTrack} title={favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'} className={`shrink-0 disabled:opacity-30 ${favorite ? 'text-rose-400' : 'text-gray-500 hover:text-rose-300'}`}><Heart size={16} fill={favorite ? 'currentColor' : 'none'} /></button>
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
          <button onClick={() => setShowLyrics((open) => !open)} title="Lyrics" aria-label="Show lyrics" aria-expanded={showLyrics} className={showLyrics ? 'text-audora-400' : 'text-gray-500 hover:text-gray-200'}><Mic2 size={16} /></button>
          <button onClick={() => navigate('/audio-effects')} title="Audio effects" aria-label="Open audio effects" className="text-gray-500 hover:text-gray-200"><SlidersHorizontal size={16} /></button>
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
