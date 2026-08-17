import { Download, X, ListPlus, Rss, Music4 } from 'lucide-react';

/** The two real stages of a job, plus its terminal outcomes. */
export type DownloadStage = 'idle' | 'downloading' | 'converting' | 'ready' | 'convert_failed';

export interface DownloadConsoleProps {
  url: string;
  onUrlChange: (value: string) => void;
  isDownloading: boolean;
  isValidUrl: boolean;
  /** Which stage the job is in — drives the readout's mode, not just its text. */
  stage: DownloadStage;
  /** Headline for the readout: current track, or the idle/standby state. */
  readoutTitle: string;
  /** Sub-line under the readout headline, e.g. "3 / 12" or a hint. */
  readoutDetail: string;
  /** 0–100. Drives the tuning scale fill. */
  percent: number;
  /**
   * True while converting with no meaningful count yet. The scale animates
   * instead of showing a number, because inventing a conversion percentage
   * would be a lie about work ffmpeg has not reported.
   */
  isIndeterminate: boolean;
  completed: number;
  failed: number;
  error: string;
  onDownload: () => void;
  onQueue: () => void;
  onCancel: () => void;
}

/**
 * The download console: an analog receiver whose controls are the real download
 * controls. The metaphor is load-bearing, not decorative — the readout shows
 * actual track progress and the transport button starts and stops the actual
 * job.
 *
 * There is no format selector: Audora always fetches the lossless source and
 * converts it to FLAC, so the only thing the user chooses is what to download.
 * The freed space carries the stage readout instead, which is the information
 * a format toggle never gave them.
 */
export default function DownloadConsole({
  url,
  onUrlChange,
  isDownloading,
  isValidUrl,
  stage,
  readoutTitle,
  readoutDetail,
  percent,
  isIndeterminate,
  completed,
  failed,
  error,
  onDownload,
  onQueue,
  onCancel,
}: DownloadConsoleProps) {
  const isConverting = stage === 'converting';
  const isReady = stage === 'ready';
  const convertFailed = stage === 'convert_failed';

  // The readout's mode label. Named for what is actually happening so the user
  // can tell a long conversion apart from a stalled download.
  const modeLabel = isConverting
    ? 'Converting'
    : isReady
    ? 'Ready'
    : convertFailed
    ? 'Conversion failed'
    : isDownloading
    ? 'Receiving'
    : 'Standby';

  return (
    <div className="console-shell flex w-[26rem] shrink-0 flex-col gap-5 rounded-3xl border border-black/50 p-5 shadow-console">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-gray-100">Receiver</h2>
          <p className="text-[11px] text-gray-400">Paste a link to begin</p>
        </div>
        <Rss
          size={16}
          className={isDownloading || isConverting ? 'text-console-readoutText' : 'text-gray-500'}
        />
      </div>

      {/* Recessed LCD readout: real state, monospaced because it is measurement. */}
      <div className="console-readout rounded-xl px-4 py-3.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-console-readoutText/55">
          {modeLabel}
        </p>
        <p
          className={`mt-1.5 truncate font-mono text-base ${
            convertFailed ? 'text-rose-300' : 'text-console-readoutText'
          }`}
        >
          {readoutTitle}
        </p>
        <div className="mt-3 flex items-baseline justify-between font-mono text-[10px] text-console-readoutText/70">
          <span className="truncate">{readoutDetail}</span>
          {/* No number while indeterminate — an invented percentage would
              misrepresent work the backend cannot measure. */}
          <span className="shrink-0 tabular-nums">
            {isIndeterminate ? '' : `${Math.round(percent)}%`}
          </span>
        </div>

        {/* Tuning scale — tick marks with a filled band showing progress. */}
        <div className="relative mt-2 h-6">
          <div
            className="absolute inset-x-0 top-2 h-1.5 rounded-full bg-black/50"
            aria-hidden
          />
          {isIndeterminate ? (
            <div className="absolute inset-x-0 top-2 h-1.5 overflow-hidden rounded-full">
              <div className="h-full w-1/3 animate-console-sweep rounded-full bg-console-readoutText/70" />
            </div>
          ) : (
            <div
              className={`absolute top-2 h-1.5 rounded-full transition-[width] duration-500 ease-out ${
                convertFailed ? 'bg-rose-400/70' : 'bg-console-readoutText/70'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          )}
          <div
            className="absolute inset-x-0 bottom-0 flex justify-between px-px"
            aria-hidden
          >
            {Array.from({ length: 21 }).map((_, tick) => (
              <span
                key={tick}
                className={`w-px ${
                  tick % 5 === 0
                    ? 'h-2 bg-console-readoutText/45'
                    : 'h-1 bg-console-readoutText/20'
                }`}
              />
            ))}
          </div>
        </div>

        {completed > 0 || failed > 0 ? (
          <p className="mt-2 font-mono text-[10px] text-console-readoutText/70">
            {completed} done{failed > 0 ? ` · ${failed} failed` : ''}
          </p>
        ) : null}
      </div>

      <label className="space-y-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-gray-400">
          Source link
        </span>
        <input
          type="text"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="music.apple.com/…"
          spellCheck={false}
          className="w-full rounded-xl border border-black/45 bg-black/35 px-3.5 py-2.5 font-mono text-[12px] text-gray-100 shadow-[inset_0_2px_6px_rgba(0,0,0,0.5)] placeholder:text-gray-600 focus:border-audora-500/60 focus:outline-none"
        />
      </label>

      {/* Replaces the old quality-preset row: the output is always the same, so
          this states it once instead of asking a question with one answer. */}
      <div className="flex items-center gap-2.5 rounded-xl border border-black/40 bg-black/25 px-3.5 py-2.5">
        <Music4 size={15} className="shrink-0 text-audora-400" />
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-medium text-gray-200">FLAC</p>
          <p className="text-[9px] text-gray-500">Lossless · converted automatically</p>
        </div>
      </div>

      <div className="mt-auto space-y-2.5">
        {isDownloading ? (
          <button
            onClick={onCancel}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-rose-500/90 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-rose-500 active:scale-[0.99]"
          >
            <X size={16} /> {isConverting ? 'Stop converting' : 'Stop download'}
          </button>
        ) : (
          <button
            onClick={onDownload}
            disabled={!isValidUrl}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
          >
            <Download size={16} /> Download
          </button>
        )}
        <button
          onClick={onQueue}
          disabled={isDownloading || !isValidUrl}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.10] bg-white/[0.05] px-4 py-2.5 text-sm text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09] disabled:text-gray-600 disabled:hover:bg-white/[0.05]"
        >
          <ListPlus size={15} /> Add to queue
        </button>

        {error && <p className="text-xs text-rose-300">{error}</p>}
      </div>
    </div>
  );
}
