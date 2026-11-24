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
  // Distinct, deterministic responses give the two channels different reflections.
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let sample = 0; sample < length; sample++) {
      const decay = (1 - sample / length) ** 3;
      data[sample] = Math.sin(sample * 1.37 + channel) * Math.sin(sample * 0.61 + channel * 2) * decay * 0.35;
    }
  }
  return impulse;
}

export function createSpatializer(context: BaseAudioContext, source: AudioNode, destination: AudioNode) {
  const dry = context.createGain();
  const wet = context.createGain();
  const room = context.createConvolver();
  const damping = context.createBiquadFilter();
  damping.type = 'lowpass';
  damping.Q.value = -3;
  const width = createStereoWidth(context);
  source.connect(dry).connect(destination);
  source.connect(room).connect(damping).connect(width.input);
  width.output.connect(wet).connect(destination);
  let previousSize: number | undefined;

  return (enabled: boolean, settings: SpatializerSettings) => {
    dry.gain.value = enabled ? settings.dry / 10 : 1;
    wet.gain.value = enabled ? settings.wet / 10 : 0;
    if (!enabled) return;

    if (settings.size !== previousSize) {
      room.buffer = roomImpulse(context, settings.size);
      previousSize = settings.size;
    }
    damping.frequency.value = (context.sampleRate / 2) * 0.075 ** (settings.damp / 10);
    width.setWidth(settings.width / 10);
  };
}
