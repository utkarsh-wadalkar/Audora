import processorSource from './advancedEffectsProcessor.js?raw';

// The ranges follow the adjustable controls in VLC's desktop audio effects panels.
// https://github.com/videolan/vlc/blob/3.0.x/modules/gui/qt/components/extended_panels.cpp#L1218-L1281
export const COMPRESSOR_CONTROLS = [
  { key: 'rmsPeak', label: 'RMS/peak', min: 0, max: 1, step: 0.001, unit: '', defaultValue: 0 },
  { key: 'attack', label: 'Attack', min: 1.5, max: 400, step: 0.1, unit: 'ms', defaultValue: 25 },
  { key: 'release', label: 'Release', min: 2, max: 800, step: 0.1, unit: 'ms', defaultValue: 100 },
  { key: 'threshold', label: 'Threshold', min: -30, max: 0, step: 0.01, unit: 'dB', defaultValue: -11 },
  { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.01, unit: ':1', defaultValue: 8 },
  { key: 'knee', label: 'Knee radius', min: 1, max: 10, step: 0.01, unit: 'dB', defaultValue: 2.5 },
  { key: 'makeupGain', label: 'Makeup gain', min: 0, max: 24, step: 0.01, unit: 'dB', defaultValue: 7 },
] as const;

export const STEREO_WIDENER_CONTROLS = [
  { key: 'delay', label: 'Delay time', min: 1, max: 100, step: 1, unit: 'ms', defaultValue: 20 },
  { key: 'feedback', label: 'Feedback gain', min: 0, max: 0.9, step: 0.1, unit: '', defaultValue: 0.3 },
  { key: 'crossfeed', label: 'Crossfeed', min: 0, max: 0.8, step: 0.1, unit: '', defaultValue: 0.3 },
  { key: 'dry', label: 'Dry mix', min: 0, max: 1, step: 0.1, unit: '', defaultValue: 0.8 },
] as const;

export const PITCH_CONTROL = { label: 'Adjust pitch', min: -12, max: 12, step: 0.25, unit: 'semitones', defaultValue: 0 } as const;

export type CompressorSettings = Record<(typeof COMPRESSOR_CONTROLS)[number]['key'], number>;
export type StereoWidenerSettings = Record<(typeof STEREO_WIDENER_CONTROLS)[number]['key'], number>;
export type AdvancedEffectsSettings = {
  compressor: boolean;
  compressorSettings: CompressorSettings;
  stereoWidener: boolean;
  stereoWidenerSettings: StereoWidenerSettings;
  pitchSemitones: number;
};

type Slider = { min: number; max: number; step: number; defaultValue: number };

function readSlider(value: unknown, { min, max, step, defaultValue }: Slider) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
  const clamped = Math.min(max, Math.max(min, value));
  return Number((min + Math.round((clamped - min) / step) * step).toFixed(3));
}

function readControls<Key extends string>(
  controls: readonly (Slider & { key: Key })[],
  saved?: Partial<Record<Key, unknown>>,
) {
  return Object.fromEntries(controls.map((control) => [
    control.key,
    readSlider(saved?.[control.key], control),
  ])) as Record<Key, number>;
}

export function readCompressorSettings(saved?: Partial<CompressorSettings>, legacyThreshold?: unknown, legacyRatio?: unknown) {
  if (!saved && (typeof legacyThreshold === 'number' || typeof legacyRatio === 'number')) {
    return readControls(COMPRESSOR_CONTROLS, {
      attack: 10, release: 250, knee: 10, makeupGain: 0, rmsPeak: 1,
      threshold: legacyThreshold, ratio: legacyRatio,
    });
  }
  return readControls(COMPRESSOR_CONTROLS, saved);
}

export function readStereoWidenerSettings(saved?: Partial<StereoWidenerSettings>) {
  return readControls(STEREO_WIDENER_CONTROLS, saved);
}

export function readPitch(saved?: unknown) {
  return readSlider(saved, PITCH_CONTROL);
}

export const DEFAULT_COMPRESSOR = readCompressorSettings();
export const DEFAULT_STEREO_WIDENER = readStereoWidenerSettings();
export const DEFAULT_PITCH = readPitch();

function createStereoWidener(context: BaseAudioContext, source: AudioNode, destination: AudioNode) {
  const input = context.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);
  source.connect(input).connect(splitter);
  merger.connect(destination);
  const channels = [0, 1].map((channel) => {
    const direct = context.createGain();
    const opposite = context.createGain();
    const delay = context.createDelay(0.1);
    const delayedOpposite = context.createGain();
    splitter.connect(direct, channel).connect(merger, 0, channel);
    splitter.connect(opposite, channel).connect(merger, 0, 1 - channel);
    splitter.connect(delay, channel).connect(delayedOpposite).connect(merger, 0, 1 - channel);
    return { direct, opposite, delay, delayedOpposite };
  });
  return (enabled: boolean, settings: StereoWidenerSettings) => {
    for (const channel of channels) {
      channel.direct.gain.value = enabled ? settings.dry : 1;
      channel.opposite.gain.value = enabled ? -settings.crossfeed : 0;
      channel.delay.delayTime.value = settings.delay / 1000;
      channel.delayedOpposite.gain.value = enabled ? -settings.feedback : 0;
    }
  };
}

export function createAdvancedEffects(context: BaseAudioContext, source: AudioNode, destination: AudioNode) {
  const mix = context.createGain();
  const direct = context.createGain();
  const nativeCompressor = context.createDynamicsCompressor();
  const nativeMix = context.createGain();
  const processed = context.createGain();
  const setWidener = createStereoWidener(context, mix, destination);
  source.connect(direct).connect(mix);
  source.connect(nativeCompressor).connect(nativeMix).connect(mix);
  processed.connect(mix);

  let processor: AudioWorkletNode | undefined;
  let settings: AdvancedEffectsSettings = {
    compressor: false, compressorSettings: DEFAULT_COMPRESSOR,
    stereoWidener: false, stereoWidenerSettings: DEFAULT_STEREO_WIDENER, pitchSemitones: DEFAULT_PITCH,
  };

  function update(next: AdvancedEffectsSettings) {
    settings = next;
    const useProcessor = Boolean(processor) && (next.compressor || next.pitchSemitones !== 0);
    direct.gain.value = useProcessor || next.compressor ? 0 : 1;
    processed.gain.value = useProcessor ? 1 : 0;
    nativeMix.gain.value = next.compressor && !processor
      ? 10 ** (next.compressorSettings.makeupGain / 20) : 0;
    if (next.compressor && !processor) {
      const compressor = next.compressorSettings;
      nativeCompressor.attack.value = compressor.attack / 1000;
      nativeCompressor.release.value = compressor.release / 1000;
      nativeCompressor.threshold.value = compressor.threshold;
      nativeCompressor.ratio.value = compressor.ratio;
      nativeCompressor.knee.value = compressor.knee * 2;
    }
    processor?.port.postMessage(next);
    setWidener(next.stereoWidener, next.stereoWidenerSettings);
  }

  async function loadProcessor() {
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    // A renderer-created blob works in both Vite and the Electron file renderer.
    const url = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
      if (context.state === 'closed') return false;
      const node = new AudioWorkletNode(context, 'audora-advanced-effects', {
        channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
      });
      node.addEventListener('processorerror', () => {
        source.disconnect(node);
        node.disconnect();
        processor = undefined;
        update(settings);
      });
      source.connect(node).connect(processed);
      processor = node;
      update(settings);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  update(settings);
  return { update, ready: loadProcessor() };
}
