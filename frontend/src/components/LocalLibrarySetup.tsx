import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { ArrowLeft, FolderOpen, Loader2, Music } from 'lucide-react';
import { api, electronAPI } from '../api/client';
import { setupConnectionError } from '../lib/setupErrors';

export default function LocalLibrarySetup({ onBack, onComplete }: {
  onBack: () => void;
  onComplete: () => void;
}) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [folderInvalid, setFolderInvalid] = useState(false);
  const openingLibrary = useRef(false);

  const browse = async () => {
    try {
      const selected = await electronAPI.selectFolder?.();
      if (selected) {
        setFolder(selected);
        setError('');
        setFolderInvalid(false);
      }
    } catch {
      setError('Could not open the folder picker. You can enter the path instead.');
    }
  };

  const openLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!folder.trim() || openingLibrary.current) return;
    openingLibrary.current = true;
    setBusy(true);
    setError('');
    setFolderInvalid(false);
    try {
      const response = await api.post('/setup/local-library', { folder: folder.trim() }, { timeout: 0 });
      if (!response.data.success) throw new Error('Library setup failed');
      onComplete();
    } catch (requestError) {
      const status = isAxiosError(requestError) ? requestError.response?.status : undefined;
      if (status === 400 || status === 422) {
        setFolderInvalid(true);
        setError('Audora couldn’t read this folder. If it’s on an external drive, reconnect the drive, then use Browse to select the music folder.');
      } else if (status === 409) {
        setError('Audora is already set up. Reopen Audora and use Settings to change your music folder.');
      } else {
        setError(setupConnectionError(requestError, 'Open library')
          ?? 'Audora couldn’t finish scanning your music. Select Open library to try again.');
      }
    } finally {
      openingLibrary.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-surface-void p-6">
      <div className="glass w-full max-w-lg rounded-3xl p-8">
        <form onSubmit={openLibrary} className="relative z-10 space-y-5">
          <button type="button" onClick={onBack} disabled={busy} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white disabled:opacity-50">
            <ArrowLeft size={16} /> Back to setup options
          </button>
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-audora-500/20 text-audora-200">
            <Music size={23} />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-100">Already have music downloaded?</h1>
            <p className="text-sm leading-relaxed text-gray-400">Choose the folder containing your songs. If you enable downloads later, Audora will save them in this folder too.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="setup-music-folder" className="block text-sm font-medium text-gray-200">Music folder</label>
            <div className="flex flex-wrap gap-2">
              <input id="setup-music-folder" value={folder} required disabled={busy}
                aria-invalid={folderInvalid || undefined} aria-describedby={folderInvalid ? 'setup-folder-error' : undefined}
                onChange={(event) => { setFolder(event.target.value); setError(''); setFolderInvalid(false); }}
                placeholder="Path to your music folder"
                className="min-w-[10rem] flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-xs text-gray-200 focus:border-audora-400 focus:outline-none" />
              {electronAPI.selectFolder && (
                <button type="button" onClick={browse} disabled={busy}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50">
                  <FolderOpen size={15} /> Browse
                </button>
              )}
            </div>
          </div>
          {error && <p id="setup-folder-error" role="alert" className="text-sm text-rose-300">{error}</p>}
          <button type="submit" disabled={busy || !folder.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-audora-500 px-5 py-3 text-sm font-semibold text-white hover:bg-audora-400 disabled:opacity-50">
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? 'Scanning music folder…' : 'Open library'}
          </button>
        </form>
      </div>
    </div>
  );
}
