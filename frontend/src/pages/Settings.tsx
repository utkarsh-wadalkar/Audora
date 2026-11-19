import { useEffect, useState } from 'react';
import { FolderOpen, LogOut, RotateCcw } from 'lucide-react';
import { api, electronAPI } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { audioEngine, DEFAULT_AUDIO_SETTINGS, EQ_FREQUENCIES, readAudioSettings, writeAudioSettings } from '../lib/audioEngine';
import type { AudioSettings } from '../lib/audioEngine';

export default function Settings() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [audio, setAudio] = useState<AudioSettings>(readAudioSettings);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [audioMessage, setAudioMessage] = useState('');
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const authStatus = useAppStore((s) => s.authStatus);

  useEffect(() => {
    api
      .get('/settings')
      .then((response) => setSettings(response.data.data || {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (audio.outputDeviceId) void audioEngine.setOutput(audio.outputDeviceId).then((ok) => {
      if (!ok) {
        updateAudio({ outputDeviceId: '' });
        setAudioMessage('The saved speaker is unavailable. Using the system default.');
      }
    });
    // Check the saved device once when Settings opens; the engine applies later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (location.hash === '#audio') document.getElementById('audio-settings')?.scrollIntoView();
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    const refresh = () => void devices.enumerateDevices()
      .then((items) => setOutputs(items.filter((item) => item.kind === 'audiooutput')))
      .catch(() => setOutputs([]));
    refresh();
    devices.addEventListener?.('devicechange', refresh);
    return () => devices.removeEventListener?.('devicechange', refresh);
  }, []);

  const updateAudio = (patch: Partial<AudioSettings>) => {
    const next = { ...audio, ...patch };
    setAudio(next);
    writeAudioSettings(next);
  };

  const changeOutput = async (deviceId: string) => {
    if (await audioEngine.setOutput(deviceId)) {
      updateAudio({ outputDeviceId: deviceId });
      setAudioMessage('Audio output changed.');
    } else setAudioMessage('This audio device is unavailable. The previous output is still selected.');
  };

  const chooseOutput = async () => {
    const media = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    if (!media?.selectAudioOutput) return;
    try {
      const selected = await media.selectAudioOutput();
      await changeOutput(selected.deviceId);
      setOutputs((current) => current.some((item) => item.deviceId === selected.deviceId) ? current : [...current, selected]);
    } catch { setAudioMessage('No speaker was selected. The current output is unchanged.'); }
  };

  const update = (key: string, value: any) => {
    setSettings((previous: any) => ({ ...previous, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    await api.post('/settings', settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const selectFolder = async (key: string) => {
    const path = await electronAPI.selectFolder?.();
    if (path) update(key, path);
  };

  const signOut = async () => {
    await api.post('/auth/logout');
    await refreshStatus();
  };

  return (
    <div className="max-w-2xl animate-rise-in space-y-6 pt-2">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-100">Settings</h1>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
          Locations
        </h2>
        <FolderField
          label="Downloads folder"
          hint="Where finished tracks are saved, organised by artist and album."
          value={settings.downloads_path || ''}
          onBrowse={() => selectFolder('downloads_path')}
        />
        <FolderField
          label="Wrapper data folder"
          hint="Working directory for the Apple Music wrapper container."
          value={settings.wrapper_data_path || ''}
          onBrowse={() => selectFolder('wrapper_data_path')}
        />
      </section>

      <section id="audio-settings" className="space-y-4 scroll-mt-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">Audio effects</h2><p className="mt-1 text-xs text-gray-500">Changes apply to playback immediately and are saved on this device.</p></div>
          <button onClick={() => updateAudio({ ...DEFAULT_AUDIO_SETTINGS, eq: [...DEFAULT_AUDIO_SETTINGS.eq] })} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white"><RotateCcw size={13} /> Reset</button>
        </div>
        <div className="glass relative space-y-4 rounded-2xl p-4">
          <label className="relative z-10 flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={audio.eqEnabled} onChange={(event) => updateAudio({ eqEnabled: event.target.checked })} className="accent-audora-400" /> Ten band equalizer</label>
          <div className="relative z-10 grid grid-cols-5 gap-3 sm:grid-cols-10">
            {EQ_FREQUENCIES.map((frequency, index) => <label key={frequency} className="flex min-w-0 flex-col items-center gap-2 text-[10px] text-gray-400">
              <span>{audio.eq[index] > 0 ? '+' : ''}{audio.eq[index]} dB</span>
              <input type="range" min={-12} max={12} step={1} value={audio.eq[index]} disabled={!audio.eqEnabled} onChange={(event) => updateAudio({ eq: audio.eq.map((gain, at) => at === index ? Number(event.target.value) : gain) })} aria-label={`${frequency} Hz gain`} className="h-24 w-5 accent-audora-400 disabled:opacity-35" style={{ writingMode: 'vertical-lr', direction: 'rtl' }} />
              <span>{frequency >= 1000 ? `${frequency / 1000}k` : frequency} Hz</span>
            </label>)}
          </div>
        </div>
        <div className="glass relative space-y-4 rounded-2xl p-4">
          <label className="relative z-10 flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={audio.compressor} onChange={(event) => updateAudio({ compressor: event.target.checked })} className="accent-audora-400" /> Dynamic range compressor</label>
          <p className="relative z-10 text-xs text-gray-500">Reduces loud peaks so quiet and loud passages are closer in level.</p>
          <label className="relative z-10 block text-xs text-gray-300">Threshold <span className="font-mono text-gray-500">{audio.compressorThreshold} dB</span><input type="range" min={-60} max={0} step={1} value={audio.compressorThreshold} disabled={!audio.compressor} onChange={(event) => updateAudio({ compressorThreshold: Number(event.target.value) })} aria-label="Compressor threshold" className="mt-1 block w-full accent-audora-400 disabled:opacity-35" /></label>
          <label className="relative z-10 block text-xs text-gray-300">Ratio <span className="font-mono text-gray-500">{audio.compressorRatio}:1</span><input type="range" min={1} max={12} step={0.5} value={audio.compressorRatio} disabled={!audio.compressor} onChange={(event) => updateAudio({ compressorRatio: Number(event.target.value) })} aria-label="Compressor ratio" className="mt-1 block w-full accent-audora-400 disabled:opacity-35" /></label>
          <label className="relative z-10 block text-sm text-gray-200">Stereo width <span className="font-mono text-xs text-gray-400">{Math.round(audio.width * 100)}%</span><input type="range" min={0} max={2} step={0.05} value={audio.width} onChange={(event) => updateAudio({ width: Number(event.target.value) })} aria-label="Stereo width" className="mt-2 block w-full accent-audora-400" /></label>
          <p className="relative z-10 text-xs text-gray-500">0% is mono, 100% preserves the recording, and higher values widen the stereo image.</p>
        </div>
        <div className="glass relative space-y-3 rounded-2xl p-4">
          <label className="relative z-10 flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={audio.spatializer} onChange={(event) => updateAudio({ spatializer: event.target.checked })} className="accent-audora-400" /> Spatializer</label>
          <p className="relative z-10 text-xs text-gray-500">Adds a short room ambience to the sound.</p>
          <label className="relative z-10 block text-xs text-gray-300">Room mix <span className="font-mono text-gray-500">{Math.round(audio.spatialMix * 100)}%</span><input type="range" min={0} max={0.5} step={0.01} value={audio.spatialMix} disabled={!audio.spatializer} onChange={(event) => updateAudio({ spatialMix: Number(event.target.value) })} aria-label="Spatializer mix" className="mt-1 block w-full accent-audora-400 disabled:opacity-35" /></label>
        </div>
        <div className="glass relative space-y-3 rounded-2xl p-4">
          <label className="relative z-10 block text-sm text-gray-200">Crossfade <span className="font-mono text-xs text-gray-400">{audio.crossfadeSeconds} seconds</span><input type="range" min={0} max={12} step={1} value={audio.crossfadeSeconds} onChange={(event) => updateAudio({ crossfadeSeconds: Number(event.target.value) })} aria-label="Crossfade duration" className="mt-2 block w-full accent-audora-400" /></label>
          <p className="relative z-10 text-xs text-gray-500">Blends the end of one queued song into the next. Set to zero to switch without an overlap.</p>
        </div>
        <div className="glass relative space-y-3 rounded-2xl p-4">
          <label htmlFor="audio-output" className="relative z-10 block text-sm text-gray-200">Audio output</label>
          <select id="audio-output" value={audio.outputDeviceId} onChange={(event) => void changeOutput(event.target.value)} disabled={!audioEngine.outputSelectionSupported} className="relative z-10 w-full rounded-xl border border-white/[0.1] bg-[#23222b] px-3 py-2 text-sm text-gray-200 disabled:opacity-50">
            <option value="">System default</option>
            {outputs.filter((item) => item.deviceId && item.deviceId !== 'default').map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Audio device ${index + 1}`}</option>)}
          </select>
          {typeof (navigator.mediaDevices as MediaDevices & { selectAudioOutput?: unknown } | undefined)?.selectAudioOutput === 'function' && <button onClick={() => void chooseOutput()} className="relative z-10 rounded-xl border border-white/[0.1] bg-white/[0.05] px-3 py-2 text-xs text-gray-200 hover:bg-white/[0.09]">Choose a speaker…</button>}
          {!audioEngine.outputSelectionSupported && <p className="relative z-10 text-xs text-gray-500">This version of the audio engine cannot select an output device. Use your system audio settings.</p>}
          {audioMessage && <p role="status" className="relative z-10 text-xs text-gray-400">{audioMessage}</p>}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
          Downloads
        </h2>

        {/* Format is not a setting: Audora always downloads the lossless source
            and converts it to FLAC, which is the only format its player can
            decode. Stated here so the absence reads as deliberate. */}
        <div className="glass space-y-1 rounded-2xl p-4">
          <span className="relative z-10 block text-sm font-medium text-gray-200">
            Format
          </span>
          <p className="relative z-10 text-xs text-gray-500">
            Every download is saved as FLAC — full lossless quality, at roughly
            30–50 MB per track.
          </p>
        </div>

        <div className="glass flex items-center justify-between gap-4 rounded-2xl p-4">
          <div className="relative z-10">
            <span className="block text-sm font-medium text-gray-200">
              Start the wrapper on launch
            </span>
            <span className="mt-0.5 block text-xs text-gray-500">
              Skips the wait before your first download of the session.
            </span>
          </div>
          <button
            onClick={() => update('auto_start_wrapper', !settings.auto_start_wrapper)}
            role="switch"
            aria-checked={!!settings.auto_start_wrapper}
            aria-label="Start the wrapper on launch"
            className={`relative z-10 h-6 w-11 shrink-0 rounded-full transition-colors duration-300 ease-out ${
              settings.auto_start_wrapper ? 'bg-audora-500' : 'bg-white/[0.12]'
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform duration-300 ease-out ${
                settings.auto_start_wrapper ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
          Account
        </h2>
        <div className="glass flex items-center justify-between gap-4 rounded-2xl p-4">
          <div className="relative z-10">
            <span className="block text-sm font-medium text-gray-200">Apple Music</span>
            <span className="mt-0.5 block text-xs text-gray-500">
              {authStatus
                ? 'Signed in. An active subscription is required to download.'
                : 'Not signed in.'}
            </span>
          </div>
          <button
            onClick={signOut}
            disabled={!authStatus}
            className="relative z-10 flex shrink-0 items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 transition-colors duration-300 ease-out hover:bg-rose-500/[0.16] disabled:border-white/[0.08] disabled:bg-white/[0.04] disabled:text-rose-200/40"
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </section>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          className="rounded-xl bg-audora-500 px-5 py-2.5 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99]"
        >
          Save settings
        </button>
        {saved && <span className="text-xs text-emerald-300">Saved</span>}
      </div>
    </div>
  );
}

function FolderField({
  label,
  hint,
  value,
  onBrowse,
}: {
  label: string;
  hint: string;
  value: string;
  onBrowse: () => void;
}) {
  return (
    <div className="glass space-y-2.5 rounded-2xl p-4">
      <div className="relative z-10">
        <span className="block text-sm font-medium text-gray-200">{label}</span>
        <span className="mt-0.5 block text-xs text-gray-500">{hint}</span>
      </div>
      <div className="relative z-10 flex gap-2">
        <input
          value={value}
          readOnly
          aria-label={label}
          placeholder="Not set"
          className="min-w-0 flex-1 rounded-xl border border-white/[0.10] bg-black/30 px-3 py-2.5 font-mono text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none"
        />
        <button
          onClick={onBrowse}
          aria-label={`Choose ${label.toLowerCase()}`}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.10] bg-white/[0.05] px-3.5 text-sm text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09]"
        >
          <FolderOpen size={15} /> Browse
        </button>
      </div>
    </div>
  );
}
