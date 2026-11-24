// VLC's desktop sliders display tenths of the underlying value as whole points.
// https://github.com/videolan/vlc/blob/3.0.x/modules/gui/qt/components/extended_panels.cpp#L1238-L1251
export const SPATIALIZER_CONTROLS = [
  { key: 'size', label: 'Size', max: 11 },
  { key: 'width', label: 'Width', max: 10 },
  { key: 'wet', label: 'Wet', max: 10 },
  { key: 'dry', label: 'Dry', max: 10 },
  { key: 'damp', label: 'Damp', max: 10 },
] as const;

export type SpatializerSettings = Record<(typeof SPATIALIZER_CONTROLS)[number]['key'], number>;

export const DEFAULT_SPATIALIZER: SpatializerSettings = { size: 8, width: 10, wet: 4, dry: 5, damp: 5 };
const ROOM_LEVEL = 0.7;

export function readSpatializerSettings(saved?: Partial<SpatializerSettings>, legacyMix?: number) {
  const settings = { ...DEFAULT_SPATIALIZER };
  if (!saved && typeof legacyMix === 'number' && Number.isFinite(legacyMix)) {
    settings.wet = Math.round(Math.max(0, Math.min(0.5, legacyMix)) * 10);
    settings.dry = 10 - settings.wet;
    settings.damp = 0;
  }
  for (const { key, max } of SPATIALIZER_CONTROLS) {
    const value = saved?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      settings[key] = Math.max(0, Math.min(max, Math.round(value)));
    }
  }
  return settings;
}

export function createStereoWidth(context: BaseAudioContext) {
  const input = context.createGain();
  // Upmix a mono source so the splitter receives a signal on both channels.
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  const splitter = context.createChannelSplitter(2);
  const output = context.createChannelMerger(2);
  const own = [context.createGain(), context.createGain()];
  const cross = [context.createGain(), context.createGain()];
  input.connect(splitter);
  for (const channel of [0, 1]) {
    splitter.connect(own[channel], channel);
    splitter.connect(cross[channel], channel);
    own[channel].connect(output, 0, channel);
    cross[channel].connect(output, 0, 1 - channel);
  }
  return {
    input,
    output,
    setWidth(width: number) {
      own.forEach((node) => { node.gain.value = (1 + width) / 2; });
      cross.forEach((node) => { node.gain.value = (1 - width) / 2; });
    },
  };
}

function roomImpulse(context: BaseAudioContext, size: number) {
  const seconds = 0.07 * 5 ** (size / 8);
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  const tailStart = Math.round(0.016 * context.sampleRate);
  const tailLevel = 4 / Math.sqrt(length);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = 0x6d2b79f5 + channel * 13579;
    for (let sample = tailStart; sample < length; sample++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const decay = (1 - sample / length) ** 3;
      data[sample] = (seed / 0x80000000 - 1) * decay * tailLevel;
    }
    const reflections = channel === 0 ? [0.009, 0.017, 0.024] : [0.012, 0.019, 0.029];
    const reflectionGains = [0.55, -0.34, 0.22];
    for (const [index, delay] of reflections.entries()) {
      const sample = Math.round(delay * context.sampleRate);
      data[sample] += reflectionGains[index];
    }

    // Calibrate the reflected signal against the dry path. The convolver's
    // default normalization can leave short room responses very quiet.
    const energy = data.reduce((sum, value) => sum + value * value, 0);
    const gain = ROOM_LEVEL / Math.sqrt(energy);
    for (let sample = 0; sample < length; sample++) data[sample] *= gain;
  }
  return impulse;
}

export function createSpatializer(context: BaseAudioContext, source: AudioNode, destination: AudioNode) {
  const dry = context.createGain();
  const wet = context.createGain();
  const room = context.createConvolver();
  room.normalize = false;
  const damping = context.createBiquadFilter();
  damping.type = 'lowpass';
  damping.Q.value = -3;
  const width = createStereoWidth(context);
  source.connect(dry).connect(destination);
  source.connect(room).connect(damping).connect(width.input);
  width.output.connect(wet).connect(destination);
  let previousSize: number | undefined;

  return (enabled: boolean, settings: SpatializerSettings) => {
    const dryLevel = enabled ? settings.dry / 10 : 1;
    const wetLevel = enabled ? settings.wet / 10 : 0;
    const headroom = Math.max(1, dryLevel + ROOM_LEVEL * wetLevel);
    dry.gain.value = dryLevel / headroom;
    wet.gain.value = wetLevel / headroom;
    if (!enabled) return;

    if (settings.size !== previousSize) {
      room.buffer = roomImpulse(context, settings.size);
      previousSize = settings.size;
    }
    damping.frequency.value = (context.sampleRate / 2) * 0.075 ** (settings.damp / 10);
    width.setWidth(settings.width / 10);
  };
}
