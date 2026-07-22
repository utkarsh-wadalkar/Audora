import { useEffect, useRef, useState } from 'react';
import { Howl } from 'howler';
import { Play, Pause, SkipBack, SkipForward, Volume2, Music } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { API_BASE } from '../api/client';
import { formatDuration } from '../lib/format';

export default function MiniPlayer() {
  const currentTrack = useAppStore((s) => s.currentTrack);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const setIsPlaying = useAppStore((s) => s.setIsPlaying);

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
      format: ['m4a', 'mp4', 'aac'],
      html5: true, // stream instead of fully buffering
      volume,
      onload: () => setDuration(howl.duration()),
      onend: () => setIsPlaying(false),
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

  return (
    <div className="h-16 bg-gray-900 border-t border-gray-800 flex items-center px-4 gap-4">
      <div className="w-10 h-10 bg-gray-800 rounded-md flex items-center justify-center text-gray-500">
        <Music size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {currentTrack?.title || 'Not Playing'}
        </p>
        <p className="text-xs text-gray-500 truncate">
          {currentTrack?.artist || 'Select a track from Library'}
        </p>
      </div>

      {/* Seek bar */}
      <div className="flex flex-col items-center gap-1 w-64">
        <div className="flex items-center gap-3">
          <button className="text-gray-400 hover:text-white" disabled>
            <SkipBack size={18} />
          </button>
          <button
            onClick={togglePlay}
            className="w-8 h-8 bg-violet-600 rounded-full flex items-center justify-center text-white hover:bg-violet-500 disabled:opacity-40"
            disabled={!currentTrack}
          >
            {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button className="text-gray-400 hover:text-white" disabled>
            <SkipForward size={18} />
          </button>
        </div>
        <div className="flex items-center gap-2 w-full text-[10px] text-gray-500">
          <span>{formatDuration(position)}</span>
          <div
            className="flex-1 h-1 bg-gray-700 rounded-full cursor-pointer"
            onClick={seek}
          >
            <div
              className="h-full bg-violet-500 rounded-full"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 w-32">
        <Volume2 size={14} className="text-gray-500" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => changeVolume(parseFloat(e.target.value))}
          className="flex-1 accent-violet-500"
        />
      </div>
    </div>
  );
}
