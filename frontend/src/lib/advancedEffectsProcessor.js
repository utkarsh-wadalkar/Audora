const FRAME_SIZE = 2048;
const HOP_SIZE = FRAME_SIZE / 4;
const BIN_COUNT = FRAME_SIZE / 2 + 1;
const TAU = 2 * Math.PI;
const WINDOW = Float32Array.from({ length: FRAME_SIZE }, (_, index) =>
  Math.sqrt(0.5 - 0.5 * Math.cos(TAU * index / FRAME_SIZE)));
const ROTATION_REAL = Float32Array.from({ length: FRAME_SIZE / 2 }, (_, index) =>
  Math.cos(-TAU * index / FRAME_SIZE));
const ROTATION_IMAGINARY = Float32Array.from({ length: FRAME_SIZE / 2 }, (_, index) =>
  Math.sin(-TAU * index / FRAME_SIZE));
const BIT_REVERSED = new Uint16Array(FRAME_SIZE);
for (let index = 1; index < FRAME_SIZE; index++) {
  BIT_REVERSED[index] = (BIT_REVERSED[index >> 1] >> 1) | ((index & 1) * (FRAME_SIZE / 2));
}

function transform(real, imaginary, inverse = false) {
  for (let index = 0; index < FRAME_SIZE; index++) {
    const reversed = BIT_REVERSED[index];
    if (reversed <= index) continue;
    const savedReal = real[index];
    const savedImaginary = imaginary[index];
    real[index] = real[reversed];
    imaginary[index] = imaginary[reversed];
    real[reversed] = savedReal;
    imaginary[reversed] = savedImaginary;
  }
  const sign = inverse ? -1 : 1;
  for (let length = 2; length <= FRAME_SIZE; length *= 2) {
    const half = length / 2;
    const stride = FRAME_SIZE / length;
    for (let start = 0; start < FRAME_SIZE; start += length) {
      for (let offset = 0; offset < half; offset++) {
        const left = start + offset;
        const right = left + half;
        const rotation = offset * stride;
        const cos = ROTATION_REAL[rotation];
        const sin = ROTATION_IMAGINARY[rotation] * sign;
        const nextReal = real[right] * cos - imaginary[right] * sin;
        const nextImaginary = real[right] * sin + imaginary[right] * cos;
        real[right] = real[left] - nextReal;
        imaginary[right] = imaginary[left] - nextImaginary;
        real[left] += nextReal;
        imaginary[left] += nextImaginary;
      }
    }
  }
}

class PitchChannel {
  input = new Float32Array(FRAME_SIZE);
  output = new Float32Array(FRAME_SIZE * 2);
  real = new Float32Array(FRAME_SIZE);
  imaginary = new Float32Array(FRAME_SIZE);
  previousPhase = new Float32Array(BIN_COUNT);
  phase = new Float32Array(BIN_COUNT);
  advance = new Float32Array(BIN_COUNT);
  magnitude = new Float32Array(BIN_COUNT);
  dominantMagnitude = new Float32Array(BIN_COUNT);
  frames = 0;

  reset() {
    this.input.fill(0);
    this.output.fill(0);
    this.frames = 0;
  }

  sample(value, ratio) {
    const frame = this.frames;
    const inputIndex = frame & (FRAME_SIZE - 1);
    const outputIndex = frame & (this.output.length - 1);
    const shifted = this.output[outputIndex];
    this.output[outputIndex] = 0;
    this.input[inputIndex] = value;
    this.frames++;
    if (this.frames >= FRAME_SIZE && this.frames % HOP_SIZE === 0) {
      this.shiftFrame(inputIndex + 1, outputIndex + 1, ratio);
    }
    return shifted;
  }

  shiftFrame(inputStart, outputStart, ratio) {
    for (let index = 0; index < FRAME_SIZE; index++) {
      this.real[index] = this.input[(inputStart + index) & (FRAME_SIZE - 1)] * WINDOW[index];
    }
    this.imaginary.fill(0);
    transform(this.real, this.imaginary);
    this.magnitude.fill(0);
    this.dominantMagnitude.fill(0);
    const firstFrame = this.frames === FRAME_SIZE;

    // Track each bin's phase between equal-length analysis windows. Shift its
    // instantaneous frequency, then keep the synthesis hop fixed to preserve tempo.
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      const phase = Math.atan2(this.imaginary[bin], this.real[bin]);
      const expected = TAU * HOP_SIZE * bin / FRAME_SIZE;
      const difference = phase - this.previousPhase[bin] - expected;
      this.previousPhase[bin] = phase;
      const target = Math.round(bin * ratio);
      if (target >= BIN_COUNT) break;
      const magnitude = Math.hypot(this.real[bin], this.imaginary[bin]);
      this.magnitude[target] += magnitude;
      if (magnitude <= this.dominantMagnitude[target]) continue;
      this.dominantMagnitude[target] = magnitude;
      this.advance[target] = (expected + difference - TAU * Math.round(difference / TAU)) * ratio;
      if (firstFrame) this.phase[target] = phase;
    }
    this.real.fill(0);
    this.imaginary.fill(0);
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      if (!this.dominantMagnitude[bin]) continue;
      const phase = this.phase[bin] + (firstFrame ? 0 : this.advance[bin]);
      this.phase[bin] = phase % TAU;
      const real = this.magnitude[bin] * Math.cos(phase);
      this.real[bin] = real;
      if (bin === 0 || bin === BIN_COUNT - 1) continue;
      const imaginary = this.magnitude[bin] * Math.sin(phase);
      this.imaginary[bin] = imaginary;
      this.real[FRAME_SIZE - bin] = real;
      this.imaginary[FRAME_SIZE - bin] = -imaginary;
    }
    transform(this.real, this.imaginary, true);
    const outputMask = this.output.length - 1;
    const overlapGain = (2 * HOP_SIZE / FRAME_SIZE) / FRAME_SIZE;
    for (let index = 0; index < FRAME_SIZE; index++) {
      this.output[(outputStart + index) & outputMask] += this.real[index] * WINDOW[index] * overlapGain;
    }
  }
}

class AdvancedEffectsProcessor extends AudioWorkletProcessor {
  pitch = [new PitchChannel(), new PitchChannel()];
  pitchRatio = 1;
  compressor = null;
  rmsPower = 0;
  gainDb = 0;
  rmsSmoothing = Math.exp(-1 / (sampleRate * 0.01));

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      const ratio = 2 ** (data.pitchSemitones / 12);
      if (ratio !== 1 && this.pitchRatio === 1) this.pitch.forEach((channel) => channel.reset());
      this.pitchRatio = ratio;
      this.compressor = data.compressor ? data.compressorSettings : null;
      if (this.compressor) {
        this.attack = Math.exp(-1000 / (this.compressor.attack * sampleRate));
        this.release = Math.exp(-1000 / (this.compressor.release * sampleRate));
      } else {
        this.rmsPower = 0;
        this.gainDb = 0;
      }
    };
  }

  compressorGain(left, right) {
    const { rmsPeak, threshold, ratio, knee, makeupGain } = this.compressor;
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const channelPower = (left * left + right * right) / 2;
    this.rmsPower = this.rmsSmoothing * this.rmsPower + (1 - this.rmsSmoothing) * channelPower;
    const level = Math.sqrt(this.rmsPower) * (1 - rmsPeak) + peak * rmsPeak;
    const aboveThreshold = 20 * Math.log10(Math.max(1e-7, level)) - threshold;
    const slope = 1 / ratio - 1;
    let target = 0;
    if (aboveThreshold > knee) target = slope * aboveThreshold;
    else if (aboveThreshold > -knee) target = slope * (aboveThreshold + knee) ** 2 / (4 * knee);
    const smoothing = target < this.gainDb ? this.attack : this.release;
    this.gainDb = smoothing * this.gainDb + (1 - smoothing) * target;
    return 10 ** ((this.gainDb + makeupGain) / 20);
  }

  process([input], [output]) {
    if (output.length < 2) return true;
    const [left, right] = output;
    const leftInput = input[0];
    const rightInput = input[1] ?? leftInput;
    for (let index = 0; index < left.length; index++) {
      let leftSample = leftInput?.[index] ?? 0;
      let rightSample = rightInput?.[index] ?? 0;
      if (this.pitchRatio !== 1) {
        leftSample = this.pitch[0].sample(leftSample, this.pitchRatio);
        rightSample = this.pitch[1].sample(rightSample, this.pitchRatio);
      }
      const gain = this.compressor ? this.compressorGain(leftSample, rightSample) : 1;
      left[index] = leftSample * gain;
      right[index] = rightSample * gain;
    }
    return true;
  }
}

registerProcessor('audora-advanced-effects', AdvancedEffectsProcessor);
