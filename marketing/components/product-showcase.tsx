'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import { Component, memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Pause, Play, RotateCcw } from 'lucide-react';
import { SONGS } from '../lib/songs.generated';

const TurntableScene = memo(dynamic(() => import('./turntable-scene'), { ssr: false }));
const subscribeToMotion = (callback: () => void) => {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
};
const reducedMotionSnapshot = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

class SceneBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onUnavailable(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function ProductShowcase() {
  const host = useRef<HTMLDivElement>(null);
  const sceneHost = useRef<HTMLDivElement>(null);
  const shelf = useRef<HTMLOListElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const playRequest = useRef(0);
  const wantsPlayback = useRef(false);
  const [nearby, setNearby] = useState(false);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reset, setReset] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playbackError, setPlaybackError] = useState('');
  const reducedMotion = useSyncExternalStore(subscribeToMotion, reducedMotionSnapshot, () => true);
  const selected = SONGS[selectedIndex];
  const onReady = useCallback(() => setReady(true), []);
  const onUnavailable = useCallback(() => { setAvailable(false); setReady(false); }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const preload = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setNearby(true); preload.disconnect(); } }, { rootMargin: '250px' });
    const visibility = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    preload.observe(element); visibility.observe(sceneHost.current || element);
    return () => { preload.disconnect(); visibility.disconnect(); };
  }, []);

  useEffect(() => {
    const list = shelf.current;
    const item = list?.children[selectedIndex];
    if (!list || !item) return;
    const boundary = list.getBoundingClientRect();
    const record = item.getBoundingClientRect();
    const distance = record.left < boundary.left ? record.left - boundary.left - 8
      : record.right > boundary.right ? record.right - boundary.right + 8 : 0;
    if (distance) list.scrollBy({ left: distance, behavior: reducedMotion ? 'instant' : 'smooth' });
  }, [selectedIndex, reducedMotion]);

  const prepareAudio = (index: number) => {
    const player = audio.current;
    const song = SONGS[index];
    if (!player) return null;
    if (player.dataset.songId !== song.id) {
      player.src = song.audioSrc;
      player.dataset.songId = song.id;
      player.load();
      setElapsed(0);
    }
    return player;
  };

  const startAudio = async (index: number) => {
    const player = prepareAudio(index);
    if (!player) return;
    const request = ++playRequest.current;
    wantsPlayback.current = true;
    setPlaybackError('');
    try {
      await player.play();
      if (request === playRequest.current) setPlaying(true);
    } catch (error) {
      if (request !== playRequest.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      wantsPlayback.current = false;
      setPlaying(false);
      setPlaybackError('This track could not start in your browser. Try another song.');
    }
  };

  const selectSong = (index: number, forcePlayback?: boolean) => {
    const normalized = (index + SONGS.length) % SONGS.length;
    const shouldPlay = forcePlayback ?? (wantsPlayback.current || playing);
    playRequest.current += 1;
    audio.current?.pause();
    setSelectedIndex(normalized);
    setPlaybackError('');
    if (audio.current?.dataset.songId || shouldPlay) prepareAudio(normalized);
    if (shouldPlay) void startAudio(normalized);
    else { wantsPlayback.current = false; setPlaying(false); }
  };

  const togglePlayback = () => {
    const player = prepareAudio(selectedIndex);
    if (!player) return;
    if (playing || wantsPlayback.current) {
      playRequest.current += 1;
      wantsPlayback.current = false;
      player.pause();
      setPlaying(false);
    } else void startAudio(selectedIndex);
  };

  const progress = selected.durationSeconds ? Math.min(100, elapsed / selected.durationSeconds * 100) : 0;
  const interactive = available && ready;
  const recordSpinning = playing && !reducedMotion;

  return <div className="listening-room" ref={host} data-active-song={selected.id}>
    <audio ref={audio} preload="none" onPlaying={() => setPlaying(true)} onWaiting={() => setPlaying(false)}
      onPause={event => { setPlaying(false); if (event.currentTarget.paused) wantsPlayback.current = false; }}
      onTimeUpdate={event => setElapsed(event.currentTarget.currentTime)} onEnded={() => selectSong(selectedIndex + 1, true)}
      onError={() => { wantsPlayback.current = false; setPlaying(false); setPlaybackError('This track could not start in your browser. Try another song.'); }} />
    <div className="listening-room-top"><span>SOME SONGS I LIKE / {String(SONGS.length).padStart(2, '0')}</span><span>A DIGITAL LIBRARY. AN ANALOG SOUL.</span></div>
    <div className="turntable-stage" ref={sceneHost} role="img" data-scene-ready={interactive} data-spinning={recordSpinning}
      aria-label={`Interactive turntable with ${selected.title} by ${selected.artist}${playing ? ', playing' : ', paused'}.`}>
      <Image className={`turntable-poster${interactive ? ' is-hidden' : ''}`} src="/images/turntable-poster.webp"
        alt="A sculpted graphite turntable with a grooved black record and polished silver tonearm."
        width={1800} height={1040} sizes="(max-width: 767px) 94vw, 1240px" />
      {nearby && available ? <SceneBoundary onUnavailable={onUnavailable}><TurntableScene
        spinning={recordSpinning && visible} visible={visible} turn={0} reset={reset} coverSrc={selected.coverSrc}
        onReady={onReady} onUnavailable={onUnavailable} /></SceneBoundary> : null}
      <div className="scene-inscription" aria-hidden="true"><span>{playing ? 'NOW PLAYING' : 'ON THE TURNTABLE'}</span><strong>{selected.title}</strong><span>{selected.artist}</span></div>
      <span className="scene-gesture">{interactive ? 'Drag to find your angle' : 'A moment for the music'}</span>
    </div>

    <div className="listening-room-bottom">
      <div className="now-playing" aria-live="polite" aria-atomic="true">
        <Image src={selected.coverSrc} alt="" width={64} height={64} />
        <div><span>SELECTED RECORD</span><h3>{selected.title}</h3><p>{selected.artist}</p></div>
      </div>
      <div className="scene-controls" aria-label="Music controls">
        <button type="button" aria-label="Previous song" onClick={() => selectSong(selectedIndex - 1)}><ArrowLeft size={16} aria-hidden="true" /></button>
        <button type="button" aria-label="Reset turntable view" disabled={!interactive} onClick={() => setReset(value => value + 1)}><RotateCcw size={15} aria-hidden="true" /></button>
        <button type="button" aria-label="Next song" onClick={() => selectSong(selectedIndex + 1)}><ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" className="scene-spin" aria-pressed={playing} onClick={togglePlayback}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {playing ? 'Pause record' : 'Start record'}
        </button>
      </div>
    </div>
    <div className="playback-progress" aria-label={`${formatTime(elapsed)} of ${formatTime(selected.durationSeconds)}`}>
      <span style={{ width: `${progress}%` }} /><time>{formatTime(elapsed)}</time><time>{formatTime(selected.durationSeconds)}</time>
    </div>
    {playbackError ? <p className="playback-error" role="status">{playbackError}</p> : null}
    {reducedMotion && playing ? <p className="motion-note">The music keeps playing while the record stays still to respect your reduced-motion setting.</p> : null}

    <div className="song-shelf">
      <div className="song-shelf-heading"><h3>Choose a record</h3><span>{SONGS.length} songs · loaded when you press play</span></div>
      <ol className="song-list" ref={shelf}>
        {SONGS.map((song, index) => <li key={song.id}>
          <button type="button" className="song-card" aria-pressed={index === selectedIndex}
            title={`${song.title} — ${song.artist}`} onClick={() => selectSong(index)}>
            <span className="song-object">
              <span className="song-vinyl" aria-hidden="true"><span /></span>
              <Image src={song.coverSrc} alt="" width={260} height={260}
                sizes="(max-width: 767px) 148px, 180px" />
              {index === selectedIndex ? <span className="song-active">ACTIVE</span> : null}
            </span>
            <strong>{song.title}</strong><span className="song-artist">{song.artist}</span>
          </button>
        </li>)}
      </ol>
    </div>
  </div>;
}
