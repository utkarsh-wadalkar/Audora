import { useEffect, useState } from 'react';
import { FolderOpen, LogOut } from 'lucide-react';
import { api, electronAPI } from '../api/client';
import { useAppStore } from '../store/useAppStore';

export default function Settings() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const refreshStatus = useAppStore((s) => s.refreshStatus);

  useEffect(() => {
    api
      .get('/settings')
      .then((r) => setSettings(r.data.data || {}))
      .catch(() => {});
  }, []);

  const update = (key: string, value: any) => {
    setSettings((prev: any) => ({ ...prev, [key]: value }));
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
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold">Settings</h2>
      <div className="space-y-4">
        <FolderField
          label="Downloads Folder"
          value={settings.downloads_path || ''}
          onBrowse={() => selectFolder('downloads_path')}
        />
        <FolderField
          label="Wrapper Data Path"
          value={settings.wrapper_data_path || ''}
          onBrowse={() => selectFolder('wrapper_data_path')}
        />

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800 space-y-3">
          <label className="block text-sm font-medium text-gray-300">Default Download Format</label>
          <select
            value={settings.download_format || 'alac'}
            onChange={(e) => update('download_format', e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="alac">ALAC (Lossless)</option>
            <option value="aac">AAC</option>
            <option value="atmos">Dolby Atmos</option>
          </select>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800 flex items-center justify-between">
          <label className="text-sm font-medium text-gray-300">Auto-start wrapper on launch</label>
          <button
            onClick={() => update('auto_start_wrapper', !settings.auto_start_wrapper)}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              settings.auto_start_wrapper ? 'bg-violet-600' : 'bg-gray-700'
            }`}
          >
            <div
              className={`w-4 h-4 bg-white rounded-full transition-transform absolute top-1 ${
                settings.auto_start_wrapper ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div className="flex gap-3">
          <button
            onClick={save}
            className="bg-violet-600 hover:bg-violet-500 px-5 py-2 rounded-lg text-sm font-medium"
          >
            {saved ? 'Saved!' : 'Save Settings'}
          </button>
          <button
            onClick={signOut}
            className="bg-red-600/20 text-red-400 hover:bg-red-600/30 px-5 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
          >
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderField({
  label,
  value,
  onBrowse,
}: {
  label: string;
  value: string;
  onBrowse: () => void;
}) {
  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-gray-800 space-y-3">
      <label className="block text-sm font-medium text-gray-300">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          readOnly
          className="flex-1 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm"
        />
        <button
          onClick={onBrowse}
          className="bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded"
        >
          <FolderOpen size={16} />
        </button>
      </div>
    </div>
  );
}
