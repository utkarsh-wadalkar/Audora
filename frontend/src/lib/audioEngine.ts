/** One playback graph for streaming, effects, output routing, and transitions. */

export interface AudioSettings {
  eqEnabled: boolean;
  eq: number[];
  compressor: boolean;
  compressorThreshold: number;
  compressorRatio: number;
  width: number;
  spatializer: boolean;
  spatialMix: number;
  crossfadeSeconds: number;
  outputDeviceId: string;
}

const STORAGE_KEY = 'audora.audio.v1';
export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  eqEnabled: false, eq: EQ_FREQUENCIES.map(() => 0), compressor: false,
  compressorThreshold: -24, compressorRatio: 3, width: 1,
  spatializer: false, spatialMix: 0.2, crossfadeSeconds: 0, outputDeviceId: '',
};

export function readAudioSettings(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...DEFAULT_AUDIO_SETTINGS, ...saved,
      eq: EQ_FREQUENCIES.map((_, index) => Math.max(-12, Math.min(12, Number(saved.eq?.[index]) || 0))),
    };
  } catch { return { ...DEFAULT_AUDIO_SETTINGS, eq: [...DEFAULT_AUDIO_SETTINGS.eq] }; }
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
  private eq: BiquadFilterNode[] = [];
  private compressor: DynamicsCompressorNode | null = null;
  private widthNodes: GainNode[] = [];
  private spatialNodes: GainNode[] = [];
  private volumeNode: GainNode | null = null;
  private outputElement: HTMLAudioElement | null = null;
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
        if (this.context && media === this.current.media) this.onError('This track could not be played. Check the file and try again.');
      });
      return { media, source, gain };
    });

    // The shared effects graph processes both decks. A wet/dry bypass keeps
    // disabled effects out of the signal path without recreating media sources.
    this.eq = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = context.createBiquadFilter();
      filter.type = index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      return filter;
    });
    let tail: AudioNode = mix;
    for (const filter of this.eq) { tail.connect(filter); tail = filter; }
    this.compressor = context.createDynamicsCompressor();
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.25;
    const compBypass = context.createGain();
    const compWet = context.createGain();
    tail.connect(compBypass);
    tail.connect(this.compressor).connect(compWet);
    const widthInput = context.createGain();
    // Convert mono to dual mono before splitting; otherwise the right channel
    // would be silent for single-channel recordings.
    widthInput.channelCount = 2;
    widthInput.channelCountMode = 'explicit';
    widthInput.channelInterpretation = 'speakers';
    compBypass.connect(widthInput);
    compWet.connect(widthInput);
    this.widthNodes = [compBypass, compWet];

    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const leftOwn = context.createGain(); const leftCross = context.createGain();
    const rightOwn = context.createGain(); const rightCross = context.createGain();
    widthInput.connect(splitter);
    splitter.connect(leftOwn, 0); splitter.connect(rightCross, 0);
    splitter.connect(rightOwn, 1); splitter.connect(leftCross, 1);
    leftOwn.connect(merger, 0, 0); leftCross.connect(merger, 0, 0);
    rightOwn.connect(merger, 0, 1); rightCross.connect(merger, 0, 1);
    this.widthNodes.push(leftOwn, leftCross, rightOwn, rightCross);
    this.volumeNode = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const room = context.createConvolver();
    const length = Math.floor(context.sampleRate * 0.35);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    // A short, deterministic decaying response adds room depth without
    // fetching an external impulse file or altering the source audio.
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let sample = 0; sample < length; sample++) {
        const decay = Math.pow(1 - sample / length, 3);
        data[sample] = (Math.sin(sample * 1.37 + channel) * Math.sin(sample * 0.61 + channel * 2)) * decay * 0.35;
      }
    }
    room.buffer = impulse;
    merger.connect(dry).connect(this.volumeNode);
    merger.connect(room).connect(wet).connect(this.volumeNode);
    this.spatialNodes = [dry, wet];
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
        ? 'This track could not be played. Check the file and try again.'
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
    this.eq.forEach((node, index) => { node.gain.value = this.settings.eqEnabled ? this.settings.eq[index] : 0; });
    this.widthNodes[0].gain.value = this.settings.compressor ? 0 : 1;
    this.widthNodes[1].gain.value = this.settings.compressor ? 1 : 0;
    const width = Math.max(0, Math.min(2, this.settings.width));
    this.widthNodes[2].gain.value = (1 + width) / 2;
    this.widthNodes[3].gain.value = (1 - width) / 2;
    this.widthNodes[4].gain.value = (1 + width) / 2;
    this.widthNodes[5].gain.value = (1 - width) / 2;
    this.compressor!.threshold.value = Math.max(-60, Math.min(0, this.settings.compressorThreshold));
    this.compressor!.ratio.value = Math.max(1, Math.min(12, this.settings.compressorRatio));
    const mix = this.settings.spatializer ? Math.max(0, Math.min(0.5, this.settings.spatialMix)) : 0;
    this.spatialNodes[0].gain.value = 1 - mix;
    this.spatialNodes[1].gain.value = mix;
    void this.setOutput(this.settings.outputDeviceId);
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
    this.eq = [];
    this.compressor = null;
    this.widthNodes = [];
    this.spatialNodes = [];
    this.volumeNode = null;
    this.active = 0;
    this.transitionTimer = null;
  }
}

export const audioEngine = new AudioEngine();
