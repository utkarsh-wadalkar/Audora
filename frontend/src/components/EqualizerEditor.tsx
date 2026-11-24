import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
  createEqResponse, EQ_FILTER_TYPES, EQ_GAIN_LIMIT, EQ_MAX_BANDS, EQ_MAX_FREQUENCY,
  EQ_MIN_FREQUENCY, EQ_PREAMP_LIMIT, normalizeBand,
} from '../lib/parametricEq';
import type { EqBand, EqSettings } from '../lib/parametricEq';

const frequencyTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const curveFrequencies = Float32Array.from({ length: 540 }, (_, index) => EQ_MIN_FREQUENCY * 1000 ** (index / 539));
const gainTicks = [24, 18, 12, 6, 0, -6, -12, -18, -24];
const bandColors = ['#bd9fff', '#71ddce', '#ffb584', '#f190c6', '#8abafb', '#d5dc90'];
const fieldStyle = 'w-full rounded-lg border border-white/10 bg-[#17161e] px-3 py-2 text-sm text-gray-100 outline-none focus:border-audora-400 disabled:opacity-40';

const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const formatTick = (hz: number) => hz >= 1000 ? `${hz / 1000}k` : String(hz);
const round = (value: number, precision: number) => Math.round(value * precision) / precision;

function NumberField({ label, value, min, max, step, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  disabled?: boolean; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="block space-y-1.5 text-xs text-gray-300">
      <span>{label}</span>
      <input
        type="number" min={min} max={max} step={step} value={draft} disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim() ? Number(draft) : value;
          const normalized = Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : value;
          setDraft(String(normalized));
          if (normalized !== value) onChange(normalized);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        className={fieldStyle}
      />
    </label>
  );
}

type Props = {
  enabled: boolean;
  settings: EqSettings;
  sampleRate: number;
  onEnabled: (enabled: boolean) => void;
  onChange: (settings: EqSettings, enable?: boolean, gesture?: object) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

export default function EqualizerEditor({ enabled, settings, sampleRate, onEnabled, onChange, canUndo, canRedo, onUndo, onRedo }: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const [size, setSize] = useState({ width: 720, height: 380 });
  const chart = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; pointer: number }>();
  const gridId = useId();
  const fillId = useId();
  const selected = settings.bands.find(({ id }) => id === selectedId);
  const selectedType = EQ_FILTER_TYPES.find(({ value }) => value === selected?.type);
  const limitReached = settings.bands.length >= EQ_MAX_BANDS;
  const response = useMemo(() => createEqResponse(sampleRate), [sampleRate]);

  useEffect(() => {
    if (!chart.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey)) return;
      const target = event.target;
      if (target instanceof Element && (target.closest('textarea, [contenteditable], dialog, [role="dialog"]') ||
          (target instanceof HTMLInputElement && !['checkbox', 'range', 'button'].includes(target.type)))) return;
      const key = event.key.toLowerCase();
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        if (!canRedo) return;
        event.preventDefault();
        onRedo();
      } else if (key === 'z' && canUndo) {
        event.preventDefault();
        onUndo();
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [canUndo, canRedo, onUndo, onRedo]);

  const left = 49;
  const top = 22;
  const right = Math.max(size.width - 25, left + 1);
  const bottom = Math.max(size.height - 40, top + 1);
  const x = (frequency: number) => left + Math.log10(frequency / EQ_MIN_FREQUENCY) * (right - left) / 3;
  const y = (gain: number) => top + (EQ_GAIN_LIMIT - gain) * (bottom - top) / (2 * EQ_GAIN_LIMIT);
  const curve = useMemo(() => response(settings, curveFrequencies), [response, settings]);
  const bandCurve = useMemo(() => selected ? response(settings, curveFrequencies, selected) : null, [response, selected, settings]);
  const points = (data: Float32Array) => Array.from(data, (value, index) =>
    `${index === 0 ? 'M' : 'L'}${x(curveFrequencies[index]).toFixed(2)},${y(Number.isFinite(value) ? value : 0).toFixed(2)}`,
  ).join(' ');
  const curvePath = points(curve);
  const chartCoordinates = (clientX: number, clientY: number) => {
    const rect = chart.current!.getBoundingClientRect();
    const px = Math.min(right, Math.max(left, clientX - rect.left));
    const py = Math.min(bottom, Math.max(top, clientY - rect.top));
    return {
      frequency: round(EQ_MIN_FREQUENCY * 1000 ** ((px - left) / (right - left)), 10),
      gain: round(EQ_GAIN_LIMIT - (py - top) * 2 * EQ_GAIN_LIMIT / (bottom - top), 10),
    };
  };

  function addBand(frequency = 1000, gain = 0) {
    if (limitReached) return;
    const band = normalizeBand({ id: crypto.randomUUID(), frequency, gain, q: 1, type: 'peaking' });
    onChange({ ...settings, bands: [...settings.bands, band] }, true);
    setSelectedId(band.id);
  }

  function editBand(id: string, patch: Partial<EqBand>, gesture?: object) {
    onChange({ ...settings, bands: settings.bands.map((band) => band.id === id ? normalizeBand({ ...band, ...patch }) : band) }, undefined, gesture);
  }

  function removeBand(id: string) {
    onChange({ ...settings, bands: settings.bands.filter((band) => band.id !== id) });
    if (id === selectedId) setSelectedId(undefined);
  }

  function moveBand(event: PointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const band = settings.bands.find(({ id }) => id === gesture.id);
    if (!band) return;
    const next = chartCoordinates(event.clientX, event.clientY);
    editBand(band.id, EQ_FILTER_TYPES.find(({ value }) => value === band.type)?.gain
      ? next : { frequency: next.frequency }, gesture);
  }

  function handleBandKey(event: KeyboardEvent<SVGGElement>, band: EqBand) {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
    switch (event.key) {
      case 'Delete':
      case 'Backspace': removeBand(band.id); break;
      case 'ArrowLeft':
      case 'ArrowRight': editBand(band.id, { frequency: round(band.frequency * 2 ** (direction * (event.shiftKey ? 1 / 3 : 1 / 48)), 10) }); break;
      case 'ArrowUp':
      case 'ArrowDown':
        if (EQ_FILTER_TYPES.find(({ value }) => value === band.type)?.gain) {
          editBand(band.id, { gain: round(band.gain + direction * (event.shiftKey ? 1 : 0.1), 10) });
        }
        break;
      case ' ':
      case 'Enter': setSelectedId(band.id); break;
      default: return;
    }
    event.preventDefault();
  }

  return (
    <section className="glass relative rounded-2xl p-4 sm:p-5" aria-label="Parametric equalizer">
      <div className="relative z-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-100">Parametric equalizer</h2>
            <p className="mt-1 text-xs text-gray-400">Double-click to add a band. Drag a point to adjust frequency and gain.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div role="group" aria-label="Equalizer history" className="flex gap-1">
              <button type="button" disabled={!canUndo} onClick={onUndo} title="Undo EQ change (Ctrl+Z)"
                aria-label="Undo EQ change" aria-keyshortcuts="Control+Z Meta+Z"
                className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-35">
                <Undo2 size={15} /> Undo
              </button>
              <button type="button" disabled={!canRedo} onClick={onRedo} title="Redo EQ change (Ctrl+Y or Ctrl+Shift+Z)"
                aria-label="Redo EQ change" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
                className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-35">
                <Redo2 size={15} /> Redo
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} className="accent-audora-400" />
              Enable equalizer
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={settings.twoPass} onChange={(event) => onChange({ ...settings, twoPass: event.target.checked })} className="accent-audora-400" />
              2 Pass
            </label>
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-[#101018]">
            <svg
              ref={chart} role="group" aria-label="Equalizer response graph"
              className="block w-full touch-none select-none" style={{ height: 'clamp(290px, 51vh, 620px)' }}
              onDoubleClick={(event) => {
                if ((event.target as Element).closest('[data-eq-band]')) return;
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX < rect.left + left || event.clientX > rect.left + right ||
                    event.clientY < rect.top + top || event.clientY > rect.top + bottom) return;
                const point = chartCoordinates(event.clientX, event.clientY);
                addBand(point.frequency, point.gain);
              }}
              onPointerMove={moveBand}
              onLostPointerCapture={() => { drag.current = undefined; }}
            >
              <defs>
                <clipPath id={gridId}><rect x={left} y={top} width={right - left} height={bottom - top} /></clipPath>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop stopColor="#a78be1" stopOpacity={0.26} />
                  <stop offset="100%" stopColor="#a78be1" stopOpacity={0.025} />
                </linearGradient>
              </defs>
              {gainTicks.map((gain) => (
                <g key={gain} aria-hidden="true">
                  <line x1={left} x2={right} y1={y(gain)} y2={y(gain)} stroke={gain === 0 ? '#615675' : '#282534'} />
                  <text x={left - 8} y={y(gain) + 4} textAnchor="end" className="fill-gray-400 font-mono text-[10px]">{gain > 0 ? '+' : ''}{gain}</text>
                </g>
              ))}
              {frequencyTicks.map((frequency, index) => (
                <g key={frequency} aria-hidden="true">
                  <line x1={x(frequency)} x2={x(frequency)} y1={top} y2={bottom} stroke="#282534" />
                  {(size.width >= 500 || index % 2 === 0 || index === frequencyTicks.length - 1) &&
                    <text x={x(frequency)} y={bottom + 19} textAnchor="middle" className="fill-gray-400 font-mono text-[10px]">{formatTick(frequency)}</text>}
                </g>
              ))}
              <text x={11} y={12} className="fill-gray-400 text-[10px]">dB</text>
              <text x={right} y={bottom + 32} textAnchor="end" className="fill-gray-400 text-[10px]">Hz</text>
              <g clipPath={`url(#${gridId})`} pointerEvents="none" opacity={enabled ? 1 : 0.55}>
                <path d={`${curvePath} L${right},${y(0)} L${left},${y(0)} Z`} fill={`url(#${fillId})`} />
                {bandCurve && <path d={points(bandCurve)} fill="none" stroke="#8e81a9" strokeWidth={1} strokeDasharray="4 5" />}
                <path d={curvePath} fill="none" stroke="#c6aff8" strokeWidth={2.5} />
              </g>
              {settings.bands.map((band, index) => {
                const color = bandColors[index % bandColors.length];
                const bandY = y(band.gain);
                return (
                  <g key={band.id} data-eq-band role="button" tabIndex={0} aria-pressed={band.id === selectedId}
                    aria-label={`Band ${index + 1}, ${band.frequency} Hz, ${formatDb(band.gain)}`}
                    transform={`translate(${x(band.frequency)}, ${bandY})`}
                    onFocus={() => setSelectedId(band.id)}
                    onKeyDown={(event) => handleBandKey(event, band)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.currentTarget.focus();
                      setSelectedId(band.id);
                      drag.current = { id: band.id, pointer: event.pointerId };
                      chart.current?.setPointerCapture(event.pointerId);
                    }}
                    className="cursor-grab focus-visible:outline-none active:cursor-grabbing"
                  >
                    <circle r={15} fill="transparent" />
                    {band.id === selectedId && <circle r={13} stroke={color} strokeOpacity={0.42} fill="none" />}
                    <circle r={9} fill="#171221" stroke={color} strokeWidth={2} />
                    <text y={3.2} textAnchor="middle" fill={color} className="pointer-events-none font-mono text-[8px] font-semibold">{index + 1}</text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="space-y-4 rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="grid grid-cols-2 items-end gap-3 xl:grid-cols-1">
              <label className="block space-y-1.5 text-xs text-gray-300">
                <span>Preset</span>
                <select value="" className={fieldStyle} onChange={(event) => {
                  if (event.target.value !== 'Flat') return;
                  onChange({ ...settings, preamp: 0, bands: [] }, true);
                  setSelectedId(undefined);
                }}>
                  <option value="" disabled>Choose a preset</option>
                  <option>Flat</option>
                </select>
              </label>
              <NumberField label="Preamp (dB)" value={settings.preamp} min={-EQ_PREAMP_LIMIT} max={EQ_PREAMP_LIMIT} step={0.1}
                onChange={(preamp) => onChange({ ...settings, preamp })} />
            </div>
            <div className="border-t border-white/10 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-gray-200">Bands</h3>
                <button type="button" onClick={() => addBand()} disabled={limitReached} className="flex items-center gap-1 text-xs text-audora-300 hover:text-white disabled:opacity-40">
                  <Plus size={14} /> Add band
                </button>
              </div>
              {settings.bands.length > 0 && <div aria-label="Select a band" className="mt-3 flex flex-wrap gap-1.5">
                {settings.bands.map((band, index) => <button key={band.id} type="button"
                  aria-label={`Select band ${index + 1}`} aria-pressed={band.id === selectedId} onClick={() => setSelectedId(band.id)}
                  style={{ color: bandColors[index % bandColors.length] }}
                  className="grid size-7 place-items-center rounded-md border border-white/10 font-mono text-xs aria-pressed:bg-white/10"
                >{index + 1}</button>)}
              </div>}
              {selected ? (
                <div className="mt-4 space-y-3" key={selected.id}>
                  <label className="block space-y-1.5 text-xs text-gray-300">
                    <span>Filter type</span>
                    <select className={fieldStyle} value={selected.type}
                      onChange={(event) => editBand(selected.id, { type: event.target.value as EqBand['type'] })}>
                      {EQ_FILTER_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <NumberField label="Frequency (Hz)" value={selected.frequency} min={EQ_MIN_FREQUENCY} max={EQ_MAX_FREQUENCY} step={0.1}
                    onChange={(frequency) => editBand(selected.id, { frequency })} />
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField label="Gain (dB)" value={selected.gain} min={-EQ_GAIN_LIMIT} max={EQ_GAIN_LIMIT} step={0.1}
                      disabled={!selectedType?.gain} onChange={(gain) => editBand(selected.id, { gain })} />
                    <NumberField label="Q (bandwidth)" value={selected.q} min={0.1} max={24} step={0.01}
                      disabled={!selectedType?.q} onChange={(q) => editBand(selected.id, { q })} />
                  </div>
                  <button type="button" onClick={() => removeBand(selected.id)} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-rose-300">
                    <Trash2 size={13} /> Remove band
                  </button>
                </div>
              ) : <p className="mt-3 text-xs text-gray-400">{settings.bands.length ? 'Select a point to edit its exact values.' : 'Add a point to shape a frequency range.'}</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
