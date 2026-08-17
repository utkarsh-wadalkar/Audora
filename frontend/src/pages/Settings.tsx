import { useEffect, useState } from 'react';
import { FolderOpen, LogOut } from 'lucide-react';
import { api, electronAPI } from '../api/client';
import { useAppStore } from '../store/useAppStore';

export default function Settings() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const authStatus = useAppStore((s) => s.authStatus);

  useEffect(() => {
    api
      .get('/settings')
      .then((response) => setSettings(response.data.data || {}))
      .catch(() => {});
  }, []);

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
