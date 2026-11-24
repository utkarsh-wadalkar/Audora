import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, RotateCw, X } from 'lucide-react';
import { electronAPI, type DesktopUpdateState } from '../api/client';

export default function UpdateIndicator() {
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = electronAPI.onUpdateState?.((state) => {
      receivedEvent = true;
      setUpdate(state);
    });
    void electronAPI.getUpdateState?.().then((state) => {
      if (active && !receivedEvent) setUpdate(state);
    }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  if (!update || update.phase === 'idle') return null;

  const downloading = update.phase === 'downloading';
  const installing = update.phase === 'installing';
  const ready = update.phase === 'ready';
  const busy = downloading || installing;
  const progress = Math.min(100, Math.max(0, update.percent ?? 0));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-full border border-audora-400/30 bg-audora-500/20 px-2.5 py-0.5 font-medium text-audora-300 hover:bg-audora-500/40"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
        {downloading ? `Downloading ${progress}%` : installing ? 'Restarting…' : ready ? 'Update ready' : 'Update available'}
      </button>
      {open && (
        <dialog
          ref={dialog}
          onClose={() => setOpen(false)}
          aria-labelledby="update-title"
          className="m-auto w-[min(28rem,90vw)] rounded-2xl border border-audora-400/25 bg-surface-lifted p-5 text-gray-100 shadow-lifted backdrop:bg-black/55"
        >
          <div className="flex items-start gap-3">
            <span className="rounded-full border border-audora-400/30 bg-audora-500/25 p-2.5 text-audora-300">
              {busy ? <Loader2 size={18} className="animate-spin" /> : ready ? <RotateCw size={18} /> : <Download size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="update-title" className="text-base font-semibold">Audora {update.version}</h2>
              <p className="mt-1 text-sm text-gray-400" aria-live="polite">
                {installing ? 'Installing the update and restarting Audora…'
                  : downloading ? 'Downloading the update…'
                  : ready ? 'Restart Audora to install the update.'
                  : 'A new version is available. Download it here and restart when you’re ready.'}
              </p>
            </div>
            <button type="button" onClick={() => dialog.current?.close()} aria-label="Close update dialog" className="rounded-full p-1 text-gray-400 hover:text-white">
              <X size={16} />
            </button>
          </div>
          {downloading && <progress aria-label="Update download progress" value={progress} max={100} className="mt-4 h-2 w-full accent-audora-400" />}
          {update.message && <p role="status" className="mt-4 text-sm text-audora-300">{update.message}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-full px-3 py-1.5 text-sm text-gray-400 hover:text-gray-100">
              {busy ? 'Close' : 'Later'}
            </button>
            {!busy && (
              <button
                type="button"
                onClick={() => void (ready ? electronAPI.installUpdate?.() : electronAPI.downloadUpdate?.())?.catch(() => {})}
                className="rounded-full bg-audora-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-audora-600"
              >
                {ready ? 'Restart and install' : 'Download update'}
              </button>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
