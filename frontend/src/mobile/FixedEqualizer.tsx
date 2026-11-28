import { useMemo, useRef } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import type { EqualizerEditorProps } from '../components/EqualizerEditor';
import { createEqResponse, EQ_FIXED_FREQUENCIES, EQ_GAIN_LIMIT, EQ_PREAMP_LIMIT } from '../lib/parametricEq';
import type { EqBand } from '../lib/parametricEq';

const bandId = (frequency: number) => `fixed-${frequency}`;
const labelHz = (frequency: number) => frequency < 1000 ? `${frequency} Hz` : `${frequency / 1000} kHz`;
const labelDb = (gain: number) => `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
const historyButton = 'grid size-11 place-items-center rounded-lg border border-white/10 text-gray-200 disabled:opacity-40';

export default function FixedEqualizer({
  settings, enabled, sampleRate, onEnabled, onChange, canUndo, canRedo, onUndo, onRedo,
}: EqualizerEditorProps) {
  const gesture = useRef<object>();
  const hasCustomBands = settings.bands.some(({ id, frequency }) => id !== bandId(frequency));
  const gains = useMemo(() => {
    if (!hasCustomBands) return EQ_FIXED_FREQUENCIES.map((frequency) =>
      settings.bands.find(({ id }) => id === bandId(frequency))?.gain ?? 0);

    const frequencies = Float32Array.from(EQ_FIXED_FREQUENCIES, (frequency) => Math.min(frequency, sampleRate / 2 - 1));
    const response = createEqResponse(sampleRate)(settings, frequencies);
    return Array.from(response, (level) => {
      const gain = (level - settings.preamp) / (settings.twoPass ? 2 : 1);
      return Math.round(Math.max(-EQ_GAIN_LIMIT, Math.min(EQ_GAIN_LIMIT, gain)) * 10) / 10;
    });
  }, [hasCustomBands, sampleRate, settings]);

  const setBandGain = (index: number, gain: number) => {
    const bands = EQ_FIXED_FREQUENCIES.map((frequency, i): EqBand => ({
      id: bandId(frequency),
      frequency,
      gain: i === index ? gain : gains[i],
      q: 1,
      type: i === 0 ? 'lowshelf' : i === EQ_FIXED_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking',
    }));
    onChange({ ...settings, bands }, undefined, gesture.current);
  };

  const sliders = [
    { label: 'Preamp', value: settings.preamp, limit: EQ_PREAMP_LIMIT,
      update: (preamp: number) => onChange({ ...settings, preamp }, undefined, gesture.current) },
    ...EQ_FIXED_FREQUENCIES.map((frequency, index) => ({
      label: labelHz(frequency), value: gains[index], limit: EQ_GAIN_LIMIT,
      update: (gain: number) => setBandGain(index, gain),
    })),
  ];

  return (
    <section className="glass relative rounded-2xl p-3" aria-label="Fixed-frequency equalizer">
      <div className="relative z-10 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} className="accent-audora-400" />
            Enable equalizer
          </label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.twoPass} onChange={(event) => onChange({ ...settings, twoPass: event.target.checked })}
              className="accent-audora-400" />
            2 Pass
          </label>
          <div className="ml-auto flex gap-1" role="group" aria-label="Equalizer history">
            <button type="button" className={historyButton} disabled={!canUndo} onClick={onUndo} aria-label="Undo EQ change"><Undo2 size={17} /></button>
            <button type="button" className={historyButton} disabled={!canRedo} onClick={onRedo} aria-label="Redo EQ change"><Redo2 size={17} /></button>
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm">
          Preset
          <select value="" className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-white/10 bg-[#17161e] px-3"
            onChange={(event) => {
              if (event.target.value === 'flat') onChange({ ...settings, preamp: 0, bands: [] }, true);
            }}>
            <option value="" disabled>Choose a preset</option>
            <option value="flat">Flat</option>
          </select>
        </label>
        <div className="grid grid-cols-6 gap-y-3 sm:grid-cols-[repeat(11,minmax(0,1fr))]">
          {sliders.map(({ label, value, limit, update }) => (
            <label key={label} className="flex min-w-0 flex-col items-center gap-1 text-center">
              <input type="range" min={-limit} max={limit} step={0.1} value={value} disabled={!enabled}
                aria-label={label} aria-valuetext={labelDb(value)}
                className="h-24 w-full max-w-11 touch-none accent-audora-400 disabled:opacity-35 sm:h-32"
                style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                onPointerDown={() => { gesture.current = {}; }}
                onPointerUp={() => { gesture.current = undefined; }}
                onPointerCancel={() => { gesture.current = undefined; }}
                onBlur={() => { gesture.current = undefined; }}
                onChange={(event) => update(Number(event.target.value))} />
              <span aria-hidden="true" className="whitespace-nowrap text-[11px] text-gray-200">{label}</span>
              <span aria-hidden="true" className="whitespace-nowrap text-[10px] tabular-nums text-gray-400">{labelDb(value)}</span>
            </label>
          ))}
        </div>
        {hasCustomBands && <p className="text-xs text-gray-400">
          These sliders show an estimate of your saved EQ. Changing a frequency band switches to the fixed bands. Undo restores your saved curve.
        </p>}
      </div>
    </section>
  );
}
