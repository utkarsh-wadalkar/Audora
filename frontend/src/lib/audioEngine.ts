/** One playback graph for streaming, effects, output routing, and transitions. */

import { createSpatializer, createStereoWidth, DEFAULT_SPATIALIZER, readSpatializerSettings } from './spatializer';
import type { SpatializerSettings } from './spatializer';
import {
  createAdvancedEffects, DEFAULT_COMPRESSOR, DEFAULT_PITCH, DEFAULT_STEREO_WIDENER,
  readCompressorSettings, readPitch, readStereoWidenerSettings,
} from './advancedEffects';
import type { AdvancedEffectsSettings } from './advancedEffects';
import { createParametricEq, DEFAULT_EQ, readEqHistory, readEqSettings } from './parametricEq';
import type { EqHistory, EqSnapshot } from './parametricEq';

export interface AudioSettings extends AdvancedEffectsSettings, EqSnapshot {
  eqHistory: EqHistory;
  pitchEnabled: boolean;
  width: number;
  spatializer: boolean;
  spatializerSettings: SpatializerSettings;
  crossfadeSeconds: number;
  outputDeviceId: string;
}

const STORAGE_KEY = 'audora.audio.v1';
const TRACK_PLAYBACK_ERROR = 'Could not play this file. The audio may be damaged or use an unsupported format.';
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  eqEnabled: false, equalizer: DEFAULT_EQ, eqHistory: { past: [], future: [] },
  compressor: false, compressorSettings: DEFAULT_COMPRESSOR,
  stereoWidener: false, stereoWidenerSettings: DEFAULT_STEREO_WIDENER,
  pitchEnabled: false, pitchSemitones: DEFAULT_PITCH, width: 1,
  spatializer: false, spatializerSettings: DEFAULT_SPATIALIZER, crossfadeSeconds: 0, outputDeviceId: '',
};

export function readAudioSettings(): AudioSettings {
  try {
    const { spatialMix, eq, compressorThreshold, compressorRatio, ...saved } = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...DEFAULT_AUDIO_SETTINGS, ...saved,
      equalizer: readEqSettings(saved.equalizer, eq),
      eqHistory: readEqHistory(saved.eqHistory),
      spatializerSettings: readSpatializerSettings(saved.spatializerSettings, spatialMix),
      compressorSettings: readCompressorSettings(saved.compressorSettings, compressorThreshold, compressorRatio),
      stereoWidenerSettings: readStereoWidenerSettings(saved.stereoWidenerSettings),
      pitchSemitones: readPitch(saved.pitchSemitones),
    };
  } catch { return { ...DEFAULT_AUDIO_SETTINGS }; }
}

export function writeAudioSettings(settings: AudioSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('audora-audio-settings'));
}

type Deck = { media: HTMLAudioElement; source: MediaElementAudioSourceNode; gain: GainNode };

export class AudioEngine {
  private context: AudioContext | null = null;
  private decks: Deck[] = [];
  private active = 0;
  private equalizer: ReturnType<typeof createParametricEq> | null = null;
  private advancedEffects: ReturnType<typeof createAdvancedEffects> | null = null;
  private stereoWidth: ReturnType<typeof createStereoWidth> | null = null;
  private spatializer: ReturnType<typeof createSpatializer> | null = null;
  private volumeNode: GainNode | null = null;
  private outputElement: HTMLAudioElement | null = null;
  private settingsOutputId: string | undefined;
  private settings = readAudioSettings();
  private nearEndSent = false;
  private transitionTimer: number | null = null;
  private playbackGeneration = 0;
  onEnded: () => void = () => {};
  onNearEnd: () => boolean = () => false;
  onMetadata: (duration: number) => void = () => {};
  onError: (message: string) => void = () => {};

  private init() {
    if (this.context) return;
    const context = new AudioContext();
    this.context = context;
    const mix = context.createGain();
    this.decks = [0, 1].map(() => {
      const media = new Audio();
      // The API runs on a different origin in development (and from file://
      // when packaged). Web Audio silences cross-origin media without CORS.
      media.crossOrigin = 'anonymous';
      media.preload = 'metadata';
      const source = context.createMediaElementSource(media);
      const gain = context.createGain();
      source.connect(gain).connect(mix);
      media.addEventListener('loadedmetadata', () => {
        if (this.context && media === this.current.media) this.onMetadata(media.duration);
      });
      media.addEventListener('timeupdate', () => {
        if (!this.context || media !== this.current.media || this.nearEndSent || !Number.isFinite(media.duration)) return;
        const seconds = this.settings.crossfadeSeconds;
        if (seconds > 0 && media.duration - media.currentTime <= seconds && media.duration - media.currentTime > 0) {
          this.nearEndSent = this.onNearEnd();
        }
      });
      media.addEventListener('ended', () => { if (this.context && media === this.current.media && !this.nearEndSent) this.onEnded(); });
      media.addEventListener('error', () => {
        if (this.context && media === this.current.media) this.onError(TRACK_PLAYBACK_ERROR);
      });
      return { media, source, gain };
    });

    const equalized = context.createGain();
    this.equalizer = createParametricEq(context, mix, equalized);
    this.stereoWidth = createStereoWidth(context);
    this.advancedEffects = createAdvancedEffects(context, equalized, this.stereoWidth.input);
    this.volumeNode = context.createGain();
    this.spatializer = createSpatializer(context, this.stereoWidth.output, this.volumeNode);
    if (typeof (context as AudioContext & { setSinkId?: unknown }).setSinkId === 'function') {
      this.volumeNode.connect(context.destination);
    } else if (typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function') {
      const destination = context.createMediaStreamDestination();
      this.volumeNode.connect(destination);
      this.outputElement = new Audio();
      this.outputElement.srcObject = destination.stream;
      this.outputElement.autoplay = true;
    } else {
      this.volumeNode.connect(context.destination);
    }
    this.applySettings();
  }

  private get current() { return this.decks[this.active]; }
  get position() { return this.context ? this.current.media.currentTime : 0; }
  get duration() { return this.context ? this.current.media.duration || 0 : 0; }
  get playing() { return !!this.context && !this.current.media.paused; }
  get sampleRate() { return this.context?.sampleRate ?? 48000; }

  preparePitch() {
    this.init();
    return this.advancedEffects!.ready;
  }

  load(url: string, crossfade = 0) {
    this.init();
    this.playbackGeneration++;
    this.nearEndSent = false;
    if (this.transitionTimer != null) { clearTimeout(this.transitionTimer); this.transitionTimer = null; }
    const old = this.current;
    const nextIndex = 1 - this.active;
    const next = this.decks[nextIndex];
    next.media.pause();
    next.media.src = url;
    next.media.load();
    const fade = Math.min(Math.max(0, crossfade), 12);
    this.active = nextIndex;
    const now = this.context!.currentTime;
    old.gain.gain.cancelScheduledValues(now);
    next.gain.gain.cancelScheduledValues(now);
    if (fade > 0 && !old.media.paused) {
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      next.gain.gain.setValueAtTime(0, now);
      next.gain.gain.linearRampToValueAtTime(1, now + fade);
      this.transitionTimer = window.setTimeout(() => { old.media.pause(); old.media.removeAttribute('src'); old.media.load(); }, fade * 1000 + 50);
    } else {
      old.media.pause(); old.media.removeAttribute('src'); old.media.load();
      old.gain.gain.value = 0;
      next.gain.gain.value = 1;
    }
    void this.play();
  }

  async play() {
    if (!this.context) return;
    const generation = this.playbackGeneration;
    const media = this.current.media;
    try {
      await this.context.resume();
      if (!this.context || generation !== this.playbackGeneration) return;
      if (this.outputElement?.paused) await this.outputElement.play();
      if (!this.context || generation !== this.playbackGeneration) return;
      await media.play();
    } catch {
      if (!this.context || generation !== this.playbackGeneration) return;
      this.onError(media.error
        ? TRACK_PLAYBACK_ERROR
        : 'Audio playback was blocked. Press Play to try again.');
    }
  }
  private finishTransition() {
    if (!this.context) return;
    if (this.transitionTimer != null) clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
    this.decks.forEach((deck, index) => {
      deck.gain.gain.cancelScheduledValues(this.context!.currentTime);
      deck.gain.gain.setValueAtTime(index === this.active ? 1 : 0, this.context!.currentTime);
      if (index !== this.active) deck.media.pause();
    });
  }
  pause() {
    this.playbackGeneration++;
    this.finishTransition();
    if (this.context) this.current.media.pause();
  }
  seek(seconds: number) {
    if (!this.context) return;
    this.finishTransition();
    this.current.media.currentTime = Math.max(0, Math.min(this.duration || seconds, seconds));
    this.nearEndSent = false;
  }
  setVolume(value: number) { this.init(); this.volumeNode!.gain.value = Math.max(0, Math.min(1, value)); }

  applySettings() {
    if (!this.context) return;
    this.settings = readAudioSettings();
    this.equalizer!(this.settings.eqEnabled, this.settings.equalizer);
    this.advancedEffects!.update({
      compressor: this.settings.compressor,
      compressorSettings: this.settings.compressorSettings,
      stereoWidener: this.settings.stereoWidener,
      stereoWidenerSettings: this.settings.stereoWidenerSettings,
      pitchSemitones: this.settings.pitchEnabled ? this.settings.pitchSemitones : 0,
    });
    this.stereoWidth!.setWidth(Math.max(0, Math.min(2, this.settings.width)));
    this.spatializer!(this.settings.spatializer, this.settings.spatializerSettings);
    if (this.settingsOutputId !== this.settings.outputDeviceId) {
      this.settingsOutputId = this.settings.outputDeviceId;
      void this.setOutput(this.settingsOutputId);
    }
  }

  async setOutput(deviceId: string): Promise<boolean> {
    this.init();
    const context = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    try {
      if (context.setSinkId) await context.setSinkId(deviceId || '');
      else if (this.outputElement) await (this.outputElement as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId || '');
      else return !deviceId;
      return true;
    } catch { return false; }
  }

  get outputSelectionSupported() {
    return typeof AudioContext !== 'undefined' && (
      typeof (AudioContext.prototype as AudioContext & { setSinkId?: unknown }).setSinkId === 'function' ||
      typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function'
    );
  }

  dispose() {
    this.playbackGeneration++;
    if (this.transitionTimer != null) clearTimeout(this.transitionTimer);
    this.decks.forEach(({ media }) => { media.pause(); media.removeAttribute('src'); media.load(); });
    if (this.outputElement) { this.outputElement.pause(); this.outputElement.srcObject = null; this.outputElement = null; }
    void this.context?.close();
    this.context = null;
    this.decks = [];
    this.equalizer = null;
    this.advancedEffects = null;
    this.stereoWidth = null;
    this.spatializer = null;
    this.volumeNode = null;
    this.settingsOutputId = undefined;
    this.active = 0;
    this.transitionTimer = null;
  }
}

export const audioEngine = new AudioEngine();
