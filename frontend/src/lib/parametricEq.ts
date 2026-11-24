export const EQ_MIN_FREQUENCY = 20;
export const EQ_MAX_FREQUENCY = 20_000;
export const EQ_GAIN_LIMIT = 24;
export const EQ_PREAMP_LIMIT = 20;
export const EQ_MAX_BANDS = 18;

export const EQ_FILTER_TYPES = [
  { value: 'peaking', label: 'Bell', gain: true, q: true },
  { value: 'lowshelf', label: 'Low shelf', gain: true, q: false },
  { value: 'highshelf', label: 'High shelf', gain: true, q: false },
  { value: 'highpass', label: 'High-pass', gain: false, q: true },
  { value: 'lowpass', label: 'Low-pass', gain: false, q: true },
  { value: 'notch', label: 'Notch', gain: false, q: true },
] as const;

type EqFilterType = (typeof EQ_FILTER_TYPES)[number]['value'];
export type EqBand = { id: string; frequency: number; gain: number; q: number; type: EqFilterType };
export type EqSettings = { preamp: number; twoPass: boolean; bands: EqBand[] };
export type EqSnapshot = { eqEnabled: boolean; equalizer: EqSettings };
export type EqHistory = { past: EqSnapshot[]; future: EqSnapshot[] };

export const DEFAULT_EQ: EqSettings = { preamp: 0, twoPass: false, bands: [] };
export const EQ_HISTORY_LIMIT = 30;
const legacyFrequencies = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function normalizeBand(band: EqBand): EqBand {
  return {
    ...band,
    frequency: bounded(band.frequency, 1000, EQ_MIN_FREQUENCY, EQ_MAX_FREQUENCY),
    gain: bounded(band.gain, 0, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT),
    q: bounded(band.q, 1, 0.1, 24),
    type: EQ_FILTER_TYPES.some(({ value }) => value === band.type) ? band.type : 'peaking',
  };
}

export function readEqSettings(saved?: Partial<EqSettings>, legacy?: unknown): EqSettings {
  const bands = Array.isArray(saved?.bands) ? saved.bands
    .filter((band) => band && typeof band.id === 'string' && band.id)
    .slice(0, EQ_MAX_BANDS)
    .filter((band, index, all) => all.findIndex(({ id }) => id === band.id) === index)
    .map(normalizeBand) : [];
  if (!Array.isArray(saved?.bands) && Array.isArray(legacy)) {
    legacyFrequencies.forEach((frequency, index) => {
      const gain = bounded(Number(legacy[index]), 0, -12, 12);
      if (gain) bands.push({
        id: `legacy-${index}`, frequency, gain, q: 1,
        type: index === 0 ? 'lowshelf' : index === 9 ? 'highshelf' : 'peaking',
      });
    });
  }
  return { bands, preamp: bounded(saved?.preamp, 0, -EQ_PREAMP_LIMIT, EQ_PREAMP_LIMIT), twoPass: saved?.twoPass === true };
}

export function readEqHistory(saved?: Partial<EqHistory>): EqHistory {
  const readStack = (stack?: EqSnapshot[]) => Array.isArray(stack)
    ? stack.slice(-EQ_HISTORY_LIMIT)
      .filter((snapshot) => typeof snapshot?.eqEnabled === 'boolean' && snapshot.equalizer)
      .map(({ eqEnabled, equalizer }) => ({ eqEnabled, equalizer: readEqSettings(equalizer) }))
    : [];
  return { past: readStack(saved?.past), future: readStack(saved?.future) };
}

function applyBand(filter: BiquadFilterNode, band: EqBand, sampleRate: number) {
  filter.type = band.type;
  filter.frequency.value = Math.min(band.frequency, sampleRate / 2 - 1);
  filter.gain.value = band.gain;
  // Web Audio uses a dB resonance parameter for low- and high-pass filters.
  filter.Q.value = band.type === 'lowpass' || band.type === 'highpass' ? 20 * Math.log10(band.q) : band.q;
}

export function createParametricEq(context: BaseAudioContext, source: AudioNode, destination: AudioNode) {
  const preamp = context.createGain();
  const filters: BiquadFilterNode[] = [];
  source.connect(preamp).connect(destination);
  return (enabled: boolean, settings: EqSettings) => {
    const bands = enabled ? settings.bands : [];
    const filterCount = bands.length * (settings.twoPass ? 2 : 1);
    if (filterCount !== filters.length) {
      preamp.disconnect();
      for (const filter of filters) filter.disconnect();
      filters.length = Math.min(filters.length, filterCount);
      while (filters.length < filterCount) filters.push(context.createBiquadFilter());
      let tail: AudioNode = preamp;
      for (const filter of filters) tail = tail.connect(filter);
      tail.connect(destination);
    }
    preamp.gain.value = enabled ? 10 ** (settings.preamp / 20) : 1;
    filters.forEach((filter, index) => applyBand(filter, bands[index % bands.length], context.sampleRate));
  };
}

export function createEqResponse(sampleRate: number) {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const filters: BiquadFilterNode[] = [];
  return (settings: EqSettings, frequencies: Float32Array<ArrayBuffer>, band?: EqBand) => {
    const bands = band ? [band] : settings.bands;
    const result = new Float32Array(frequencies.length).fill(band ? 0 : settings.preamp);
    const magnitude = new Float32Array(frequencies.length);
    const phase = new Float32Array(frequencies.length);
    bands.forEach((current, index) => {
      const filter = filters[index] ?? (filters[index] = context.createBiquadFilter());
      applyBand(filter, current, sampleRate);
      filter.getFrequencyResponse(frequencies, magnitude, phase);
      for (let point = 0; point < result.length; point++) {
        result[point] += (settings.twoPass ? 2 : 1) * 20 * Math.log10(Math.max(0.00001, magnitude[point]));
      }
    });
    return result;
  };
}
