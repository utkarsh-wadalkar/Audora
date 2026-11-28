import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { RotateCcw } from 'lucide-react';
import { audioEngine, DEFAULT_AUDIO_SETTINGS, readAudioSettings, writeAudioSettings } from '../lib/audioEngine';
import type { AudioSettings } from '../lib/audioEngine';
import { COMPRESSOR_CONTROLS, PITCH_CONTROL, STEREO_WIDENER_CONTROLS } from '../lib/advancedEffects';
import { SPATIALIZER_CONTROLS } from '../lib/spatializer';
import { EQ_HISTORY_LIMIT } from '../lib/parametricEq';
import EqualizerEditor from '../components/EqualizerEditor';
import type { EqualizerEditorProps } from '../components/EqualizerEditor';

const tabs = ['Equalizer', 'Compressor', 'Spatializer', 'Stereo Widener', 'Advanced'] as const;
type EffectsTab = (typeof tabs)[number];
type Slider = { label: string; min: number; max: number; step: number; unit: string };

function EffectSwitch({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-200">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-audora-400" />
      {label}
    </label>
  );
}

function SliderBank<Key extends string>({ controls, values, enabled, onChange }: {
  controls: readonly (Slider & { key: Key })[]; values: Record<Key, number>;
  enabled: boolean; onChange: (key: Key, value: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))]">
      {controls.map(({ key, label, min, max, step, unit }) => (
        <label key={key} className="flex min-w-0 flex-col items-center gap-2 text-center text-xs text-gray-300">
          <input type="range" min={min} max={max} step={step} value={values[key]} disabled={!enabled}
            onChange={(event) => onChange(key, Number(event.target.value))}
            aria-label={label} aria-valuetext={`${unit === 'point' ? values[key].toFixed(1) : values[key]}${unit && unit !== 'point' ? (unit === ':1' ? unit : ` ${unit}`) : ''}`}
            className="h-36 w-6 accent-audora-400 disabled:opacity-35"
            style={{ writingMode: 'vertical-lr', direction: 'rtl' }} />
          <span aria-hidden="true" className="font-mono text-gray-400">
            {unit === 'point' ? values[key].toFixed(1) : values[key]}{unit && unit !== 'point' && (unit === ':1' ? unit : ` ${unit}`)}
          </span>
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function HorizontalSlider({ control, value, disabled, onChange }: {
  control: Slider; value: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-gray-200">
      {control.label} <span className="font-mono text-xs text-gray-400">{value} {control.unit}</span>
      <input type="range" min={control.min} max={control.max} step={control.step} value={value}
        aria-label={control.label} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 block w-full accent-audora-400 disabled:opacity-35" />
    </label>
  );
}

export default function AudioEffects({ openSystemAudioOutput, equalizerEditor: EqEditor = EqualizerEditor }: {
  openSystemAudioOutput?: () => void;
  equalizerEditor?: ComponentType<EqualizerEditorProps>;
} = {}) {
  const [audio, setAudio] = useState<AudioSettings>(readAudioSettings);
  const currentAudio = useRef(audio);
  const lastEqGesture = useRef<object>();
  const [tab, setTab] = useState<EffectsTab>('Equalizer');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [audioMessage, setAudioMessage] = useState('');
  const [pitchMessage, setPitchMessage] = useState('');
  const outputRequest = useRef(0);
  const pitchRequest = useRef(0);
  const compact = Boolean(openSystemAudioOutput);

  useEffect(() => {
    const request = ++outputRequest.current;
    if (!openSystemAudioOutput && audio.outputDeviceId) void audioEngine.setOutput(audio.outputDeviceId).then((ok) => {
      if (!ok && request === outputRequest.current) {
        updateAudio({ outputDeviceId: '' });
        setAudioMessage('The saved speaker is unavailable. Using the system default.');
      }
    });
    // Check the saved device once when the page opens; the engine applies later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      outputRequest.current++;
      pitchRequest.current++;
    };
  }, []);

  useEffect(() => {
    if (openSystemAudioOutput) return;
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    const refresh = () => void devices.enumerateDevices()
      .then((items) => setOutputs(items.filter((item) => item.kind === 'audiooutput')))
      .catch(() => setOutputs([]));
    refresh();
    devices.addEventListener?.('devicechange', refresh);
    return () => devices.removeEventListener?.('devicechange', refresh);
  }, []);

  const saveAudio = (next: AudioSettings) => {
    currentAudio.current = next;
    setAudio(next);
    writeAudioSettings(next);
  };

  const updateAudio = (patch: Partial<AudioSettings>, gesture?: object) => {
    const current = currentAudio.current;
    const next = { ...current, ...patch, eqHistory: current.eqHistory };
    const eqChanged = next.eqEnabled !== current.eqEnabled ||
      (next.equalizer !== current.equalizer && JSON.stringify(next.equalizer) !== JSON.stringify(current.equalizer));
    if (eqChanged) {
      // Every pointer move updates playback, but the entire drag is one edit.
      if (!gesture || gesture !== lastEqGesture.current) {
        next.eqHistory = {
          past: [...current.eqHistory.past, { eqEnabled: current.eqEnabled, equalizer: current.equalizer }].slice(-EQ_HISTORY_LIMIT),
          future: [],
        };
      }
      lastEqGesture.current = gesture;
    }
    saveAudio(next);
  };

  const travelEqHistory = (direction: 'past' | 'future') => {
    const current = currentAudio.current;
    const stack = current.eqHistory[direction];
    const saved = stack[stack.length - 1];
    if (!saved) return;
    const opposite = direction === 'past' ? 'future' : 'past';
    lastEqGesture.current = undefined;
    saveAudio({
      ...current,
      ...saved,
      eqHistory: {
        ...current.eqHistory,
        [direction]: stack.slice(0, -1),
        [opposite]: [...current.eqHistory[opposite], { eqEnabled: current.eqEnabled, equalizer: current.equalizer }].slice(-EQ_HISTORY_LIMIT),
      },
    });
  };

  const changeOutput = async (deviceId: string, request = ++outputRequest.current) => {
    const ok = await audioEngine.setOutput(deviceId);
    if (request !== outputRequest.current) return false;
    if (ok) {
      updateAudio({ outputDeviceId: deviceId });
      setAudioMessage('Audio output changed.');
    } else setAudioMessage('This audio device is unavailable. The previous output is still selected.');
    return ok;
  };

  const chooseOutput = async () => {
    const media = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    if (!media?.selectAudioOutput) return;
    const request = ++outputRequest.current;
    try {
      const selected = await media.selectAudioOutput();
      if (request === outputRequest.current && await changeOutput(selected.deviceId, request)) {
        setOutputs((current) => current.some((item) => item.deviceId === selected.deviceId) ? current : [...current, selected]);
      }
    } catch {
      if (request === outputRequest.current) setAudioMessage('No speaker was selected. The current output is unchanged.');
    }
  };

  async function enablePitch(enabled: boolean) {
    const request = ++pitchRequest.current;
    setPitchMessage('');
    if (!enabled) {
      updateAudio({ pitchEnabled: false });
      return;
    }
    const ready = await audioEngine.preparePitch();
    if (request !== pitchRequest.current) return;
    if (ready) updateAudio({ pitchEnabled: true });
    else setPitchMessage('Pitch adjustment is unavailable in this audio engine.');
  }

  return (
    <div className={compact ? 'animate-rise-in space-y-3' : 'animate-rise-in space-y-4 pt-2'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className={compact ? 'text-lg font-semibold text-gray-100' : 'text-2xl font-semibold tracking-tight text-gray-100'}>Audio effects</h1>
          {!compact && <p className="mt-1 text-xs text-gray-500">Changes apply during playback and save on this device.</p>}
        </div>
        <button type="button" onClick={() => {
          outputRequest.current++;
          pitchRequest.current++;
          setAudioMessage('');
          setPitchMessage('');
          updateAudio(DEFAULT_AUDIO_SETTINGS);
        }} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-400 hover:text-white">
          <RotateCcw size={13} /> Reset all effects
        </button>
      </div>
      <div role="tablist" aria-label="Audio effect" className={`flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 ${compact ? 'overflow-x-auto' : 'flex-wrap'}`}>
        {tabs.map((name, index) => (
          <button type="button" role="tab" key={name} id={`effect-tab-${index}`} aria-controls="effect-panel"
            aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
            onKeyDown={(event) => {
              const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!direction) return;
              event.preventDefault();
              const next = (index + direction + tabs.length) % tabs.length;
              setTab(tabs[next]);
              document.getElementById(`effect-tab-${next}`)?.focus();
            }}
            className={`rounded-lg text-gray-400 hover:text-white aria-selected:bg-audora-400/15 aria-selected:text-audora-200 ${compact ? 'min-h-[44px] shrink-0 px-2 text-xs' : 'px-3 py-2 text-sm'}`}>
            {name}
          </button>
        ))}
      </div>

      <div id="effect-panel" role="tabpanel" aria-labelledby={`effect-tab-${tabs.indexOf(tab)}`}>
        {tab === 'Equalizer' && <EqEditor enabled={audio.eqEnabled} settings={audio.equalizer} sampleRate={audioEngine.sampleRate}
          onEnabled={(eqEnabled) => updateAudio({ eqEnabled })}
          onChange={(equalizer, enable, gesture) => updateAudio({ equalizer, eqEnabled: enable ?? currentAudio.current.eqEnabled }, gesture)}
          canUndo={audio.eqHistory.past.length > 0} canRedo={audio.eqHistory.future.length > 0}
          onUndo={() => travelEqHistory('past')} onRedo={() => travelEqHistory('future')} />}

        {tab === 'Compressor' && <section className="glass relative max-w-5xl rounded-2xl p-5">
          <div className="relative z-10 space-y-5">
            <EffectSwitch label="Enable compressor" checked={audio.compressor} onChange={(compressor) => updateAudio({ compressor })} />
            <p className="text-xs text-gray-400">Reduce loud peaks and adjust the overall level after compression.</p>
            <SliderBank controls={COMPRESSOR_CONTROLS} values={audio.compressorSettings} enabled={audio.compressor}
              onChange={(key, value) => updateAudio({ compressorSettings: { ...currentAudio.current.compressorSettings, [key]: value } })} />
          </div>
        </section>}

        {tab === 'Spatializer' && <section className="glass relative max-w-5xl rounded-2xl p-5">
          <div className="relative z-10 space-y-5">
            <EffectSwitch label="Enable spatializer" checked={audio.spatializer} onChange={(spatializer) => updateAudio({ spatializer })} />
            <p className="text-xs text-gray-400">Shape the room sound and blend it with the original audio.</p>
            <SliderBank controls={SPATIALIZER_CONTROLS.map((control) => ({ ...control, min: 0, step: 1, unit: 'point' }))}
              values={audio.spatializerSettings} enabled={audio.spatializer}
              onChange={(key, value) => updateAudio({ spatializerSettings: { ...currentAudio.current.spatializerSettings, [key]: value } })} />
            <p className="text-xs text-gray-400">Width changes the spread of the room reflections. Wet controls the reflections and Dry controls the original signal.</p>
          </div>
        </section>}

        {tab === 'Stereo Widener' && <section className="glass relative max-w-5xl rounded-2xl p-5">
          <div className="relative z-10 space-y-5">
            <EffectSwitch label="Enable stereo widener" checked={audio.stereoWidener} onChange={(stereoWidener) => updateAudio({ stereoWidener })} />
            <p className="text-xs text-gray-400">Spread the stereo image with adjustable delay and crossfeed.</p>
            <SliderBank controls={STEREO_WIDENER_CONTROLS} values={audio.stereoWidenerSettings} enabled={audio.stereoWidener}
              onChange={(key, value) => updateAudio({ stereoWidenerSettings: { ...currentAudio.current.stereoWidenerSettings, [key]: value } })} />
          </div>
        </section>}

        {tab === 'Advanced' && <section className="glass relative max-w-2xl rounded-2xl p-5">
          <div className="relative z-10 space-y-5">
            <div className="space-y-4 border-b border-white/10 pb-5">
              <EffectSwitch label="Enable pitch adjustment" checked={audio.pitchEnabled} onChange={(enabled) => void enablePitch(enabled)} />
              <HorizontalSlider control={PITCH_CONTROL} value={audio.pitchSemitones} disabled={!audio.pitchEnabled}
                onChange={(pitchSemitones) => updateAudio({ pitchSemitones })} />
              <p className="text-xs text-gray-400">Shift pitch up or down while keeping the playback tempo.</p>
              {pitchMessage && <p role="status" className="text-xs text-gray-300">{pitchMessage}</p>}
            </div>
            <HorizontalSlider control={{ label: 'Stereo width', min: 0, max: 200, step: 5, unit: '%' }}
              value={Math.round(audio.width * 100)} onChange={(value) => updateAudio({ width: value / 100 })} />
            <HorizontalSlider control={{ label: 'Crossfade duration', min: 0, max: 12, step: 1, unit: 'seconds' }}
              value={audio.crossfadeSeconds} onChange={(crossfadeSeconds) => updateAudio({ crossfadeSeconds })} />
            {openSystemAudioOutput ? (
              <button type="button" onClick={openSystemAudioOutput} className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-200">
                Audio output
              </button>
            ) : <>
            <div>
              <label htmlFor="audio-output" className="mb-2 block text-sm text-gray-200">Audio output</label>
              <select id="audio-output" value={audio.outputDeviceId} onChange={(event) => void changeOutput(event.target.value)}
                disabled={!audioEngine.outputSelectionSupported} className="w-full rounded-lg border border-white/10 bg-[#23222b] px-3 py-2 text-sm text-gray-200 disabled:opacity-50">
                <option value="">System default</option>
                {outputs.filter((item) => item.deviceId && item.deviceId !== 'default').map((item, index) =>
                  <option key={item.deviceId} value={item.deviceId}>{item.label || `Audio device ${index + 1}`}</option>)}
              </select>
            </div>
            {typeof (navigator.mediaDevices as MediaDevices & { selectAudioOutput?: unknown } | undefined)?.selectAudioOutput === 'function' &&
              <button type="button" onClick={() => void chooseOutput()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10">Choose a speaker…</button>}
            {!audioEngine.outputSelectionSupported && <p className="text-xs text-gray-500">This version of the audio engine cannot select an output device. Use your system audio settings.</p>}
            {audioMessage && <p role="status" className="text-xs text-gray-400">{audioMessage}</p>}
            </>}
          </div>
        </section>}
      </div>
    </div>
  );
}
