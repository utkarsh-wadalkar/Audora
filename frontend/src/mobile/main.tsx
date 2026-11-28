import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, LibraryBig, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import AudioEffects from '../pages/AudioEffects';
import { audioEngine, readAudioSettings } from '../lib/audioEngine';
import FixedEqualizer from './FixedEqualizer';
import MusicLibrary, { button } from './MusicLibrary';
import type { LibrarySnapshot, Track } from './catalog';
import '../index.css';

declare global {
  interface Window {
    AudoraAndroid: {
      chooseFolder(): void;
      rescan(): void;
      audioOutput(): void;
      nowPlaying(track: string): void;
      playbackStopped(): void;
    };
  }
}

const emptyLibrary: LibrarySnapshot = { folder: '', hasFolder: false, scanning: false, error: '', unreadableFolders: 0, tracks: [] };
const time = (seconds: number) => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
const chooseFolder = () => window.AudoraAndroid.chooseFolder();
const rescan = () => window.AudoraAndroid.rescan();
const openAudioOutput = () => window.AudoraAndroid.audioOutput();
const LibraryScreen = memo(MusicLibrary);
const EffectsScreen = memo(AudioEffects);

function App() {
  const [page, setPage] = useState<'library' | 'effects'>('library');
  const [library, setLibrary] = useState(emptyLibrary);
  const [status, setStatus] = useState('');
  const [track, setTrack] = useState<Track>();
  const [controls, setControls] = useState({ current: 0, duration: 0, playing: false, index: -1 });
  const [preview, setPreview] = useState<number>();
  const [seeks, setSeeks] = useState(0);
  const reportPosition = useCallback(() => setSeeks((count) => count + 1), []);
  const scrubbing = useRef(false);
  const queue = useRef<Track[]>([]);
  const index = useRef(-1);

  const updateControls = useCallback(() => {
    const duration = audioEngine.duration;
    setControls({
      current: audioEngine.position,
      duration: Number.isFinite(duration) ? duration : 0,
      playing: audioEngine.playing,
      index: index.current,
    });
  }, []);

  const playAt = useCallback((position: number, fade = 0) => {
    const next = queue.current[position];
    if (!next) return false;
    index.current = position;
    setTrack(next);
    setStatus('');
    setPreview(undefined);
    audioEngine.load('/tracks/' + next.id, fade);
    updateControls();
    return true;
  }, [updateControls]);

  const resume = useCallback(() => {
    if (index.current < 0) return;
    setStatus('');
    if (audioEngine.duration > 0) void audioEngine.play();
    else playAt(index.current);
    updateControls();
  }, [playAt, updateControls]);

  const playLibrary = useCallback((tracks: Track[], position: number) => {
    queue.current = tracks;
    playAt(position);
  }, [playAt]);

  useEffect(() => {
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void fetch('/library.json', { signal: request.signal })
        .then((result) => {
          if (!result.ok) throw new Error('Local library unavailable');
          return result.json() as Promise<LibrarySnapshot>;
        })
        .then((result) => {
          if (request.signal.aborted) return;
          setLibrary(result);
          const playing = queue.current[index.current];
          if (playing && !result.scanning && !result.error && !result.tracks.some(({ id }) => id === playing.id)) {
            audioEngine.pause();
            queue.current = [];
            index.current = -1;
            setTrack(undefined);
            setPreview(undefined);
            updateControls();
          }
        })
        .catch(() => {
          if (!request.signal.aborted) setLibrary((current) => ({
            ...current, error: 'Couldn’t load your music library. Reopen Audora and try again.',
          }));
        });
    };
    const apply = () => audioEngine.applySettings();
    const pause = () => { audioEngine.pause(); updateControls(); };
    const outputFailure = () => setStatus('Open your phone’s sound settings to choose an audio output.');
    audioEngine.onNearEnd = () => {
      const remaining = audioEngine.duration - audioEngine.position;
      if (remaining > audioEngine.duration / 2) return false;
      return playAt(index.current + 1, Math.min(remaining, readAudioSettings().crossfadeSeconds));
    };
    audioEngine.onEnded = () => { if (!playAt(index.current + 1)) updateControls(); };
    audioEngine.onError = (message) => { setStatus(message); updateControls(); };
    audioEngine.onMetadata = updateControls;
    window.addEventListener('audora-library', refresh);
    window.addEventListener('audora-audio-settings', apply);
    window.addEventListener('audora-headphones-unplugged', pause);
    window.addEventListener('audora-output-unavailable', outputFailure);
    const transport = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === 'play') { resume(); return; }
      if (command === 'next') playAt(index.current + 1);
      else if (command === 'previous') playAt(index.current - 1);
      else if (command.startsWith('seek:')) { audioEngine.seek(Number(command.slice(5)) / 1000); reportPosition(); }
      else {
        audioEngine.pause();
        // Dismissing the notification ends the session, so the player releases the track too.
        if (command === 'stop') { index.current = -1; setTrack(undefined); setPreview(undefined); }
      }
      updateControls();
    };
    window.addEventListener('audora-transport', transport);
    const ticker = window.setInterval(() => { if (index.current >= 0) updateControls(); }, 220);
    refresh();
    return () => {
      pending?.abort();
      window.removeEventListener('audora-library', refresh);
      window.removeEventListener('audora-audio-settings', apply);
      window.removeEventListener('audora-headphones-unplugged', pause);
      window.removeEventListener('audora-output-unavailable', outputFailure);
      window.removeEventListener('audora-transport', transport);
      clearInterval(ticker);
      audioEngine.dispose();
    };
  }, [playAt, reportPosition, resume, updateControls]);

  useEffect(() => {
    if (!track) {
      window.AudoraAndroid.playbackStopped();
      return;
    }
    window.AudoraAndroid.nowPlaying(JSON.stringify({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: controls.duration,
      position: audioEngine.position,
      playing: controls.playing,
      hasPrevious: controls.index > 0,
      hasNext: controls.index + 1 < queue.current.length,
    }));
  }, [track, controls.duration, controls.playing, controls.index, seeks]);

  function togglePlayback() {
    if (!audioEngine.playing) resume();
    else {
      audioEngine.pause();
      updateControls();
    }
  }

  return <div className="mx-auto flex h-screen max-w-4xl flex-col bg-surface-void text-gray-100">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
      <span className="wordmark text-[2rem] leading-none text-[#deb586]" style={{ fontFamily: 'Caveat, serif' }}>Audora</span>
      <nav aria-label="Audora" className="flex gap-1">
        <button className={button + ' inline-flex items-center gap-1.5 aria-pressed:bg-audora-400/20'} aria-pressed={page === 'library'}
          onClick={() => setPage('library')}><LibraryBig size={16} /> Library</button>
        <button className={button + ' inline-flex items-center gap-1.5 aria-pressed:bg-audora-400/20'} aria-pressed={page === 'effects'}
          onClick={() => setPage('effects')}><AudioLines size={16} /> Audio effects</button>
      </nav>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
      {status && !track && <p role="alert" className="mb-3 text-sm text-rose-300">{status}</p>}
      <div hidden={page !== 'library'}>
        <LibraryScreen library={library} onChoose={chooseFolder} onRescan={rescan} onPlay={playLibrary} />
      </div>
      {page === 'effects' && <EffectsScreen openSystemAudioOutput={openAudioOutput} equalizerEditor={FixedEqualizer} />}
    </main>
    {track && <footer className="shrink-0 border-t border-white/10 bg-[#18151f] px-4 pb-2 pt-3">
      <p className="truncate text-sm font-medium">{track.title}</p>
      {status && <p role="alert" className="mt-1 text-sm text-rose-300">{status}</p>}
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span className="tabular-nums">{time(preview ?? controls.current)}</span>
        <input aria-label="Seek" aria-valuetext={time(preview ?? controls.current)} type="range" min="0" max={controls.duration || 1} step="0.05"
          disabled={!controls.duration} value={Math.min(preview ?? controls.current, controls.duration)}
          className="h-8 min-w-0 flex-1 accent-audora-400"
          onPointerDown={() => { scrubbing.current = true; }}
          onPointerCancel={() => { scrubbing.current = false; setPreview(undefined); }}
          onPointerUp={(event) => {
            scrubbing.current = false;
            audioEngine.seek(Number(event.currentTarget.value));
            setPreview(undefined);
            updateControls();
            reportPosition();
          }}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (scrubbing.current) setPreview(seconds);
            else { audioEngine.seek(seconds); updateControls(); reportPosition(); }
          }} />
        <span className="tabular-nums">{time(controls.duration)}</span>
      </div>
      <div className="flex justify-center gap-3">
        <button aria-label="Previous track" className={button} disabled={controls.index < 1} onClick={() => playAt(index.current - 1)}><SkipBack size={19} /></button>
        <button aria-label={controls.playing ? 'Pause' : 'Play'} className={button + ' bg-audora-600 px-4'} onClick={togglePlayback}>
          {controls.playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button aria-label="Next track" className={button} disabled={controls.index + 1 >= queue.current.length} onClick={() => playAt(index.current + 1)}><SkipForward size={19} /></button>
      </div>
    </footer>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
