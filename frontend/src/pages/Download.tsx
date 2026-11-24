import { useEffect, useState, useRef } from 'react';
import { api, electronAPI } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore } from '../store/useAppStore';
import DownloadConsole, { type DownloadStage } from '../components/DownloadConsole';
import LogTerminal, { type LogLine } from '../components/LogTerminal';

/** Bounded so a long download session cannot grow the log without limit. */
const MAX_LOG_LINES = 500;

function currentClock(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function DownloadPage() {
  const [url, setUrl] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<any>(null);
  const [error, setError] = useState('');

  // Monotonic id so append-only lines get stable React keys.
  const nextLineId = useRef(0);
  const receivedProgress = useRef(false);

  useEffect(() => {
    let active = true;
    api.get('/download/result').then(({ data }) => {
      if (active && !receivedProgress.current) setProgress(data.data ?? null);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const addToQueue = useAppStore((s) => s.addToQueue);

  useWebSocket('/ws/logs', {
    onMessage: (data) => {
      if (data?.type !== 'log') return;
      // Timestamp at arrival — a value computed during render would relabel
      // every existing line on each repaint.
      const line: LogLine = {
        id: nextLineId.current++,
        timestamp: currentClock(),
        level: typeof data.level === 'string' ? data.level.toLowerCase() : 'info',
        text: String(data.message ?? ''),
      };
      setLogLines((previous) => [...previous.slice(-(MAX_LOG_LINES - 1)), line]);
    },
  });

  useWebSocket('/ws/progress', {
    onMessage: (data) => {
      receivedProgress.current = true;
      setProgress(data);
      // "converting" is still an active job — the transport stays in its
      // stop-able state so a long conversion cannot look finished or stuck.
      if (
        data?.status === 'completed' ||
        data?.status === 'failed' ||
        data?.status === 'cancelled' ||
        data?.status === 'convert_failed'
      ) {
        setIsDownloading(false);
      } else if (data?.status === 'downloading' || data?.status === 'retrying' || data?.status === 'converting') {
        setIsDownloading(true);
      }
    },
  });

  const isValidUrl = /music\.apple\.com/.test(url);

  const handleDownload = async () => {
    if (!isValidUrl) {
      setError('That link is not an Apple Music URL. Copy the share link for an album, playlist or track.');
      return;
    }
    setError('');
    receivedProgress.current = true;
    setIsDownloading(true);
    setLogLines([]);
    setProgress(null);
    try {
      // No format: the backend always fetches lossless and converts to FLAC.
      const response = await api.post('/download', { url });
      if (!response.data.success) {
        setError(response.data.error || 'The download could not be started.');
        setIsDownloading(false);
      }
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || requestError.message);
      setIsDownloading(false);
    }
  };

  const handleQueue = async () => {
    if (!isValidUrl) {
      setError('That link is not an Apple Music URL. Copy the share link for an album, playlist or track.');
      return;
    }
    setError('');
    await addToQueue(url);
    setUrl('');
  };

  const handleCancel = async () => {
    await api.post('/download/cancel');
    setIsDownloading(false);
  };

  // --- Stage derivation ----------------------------------------------------
  // The backend reports which of the two real stages a job is in; the UI never
  // infers or invents one.
  const status = progress?.status;
  const stage: DownloadStage =
    status === 'converting'
      ? 'converting'
      : status === 'convert_failed'
      ? 'convert_failed'
      : status === 'failed'
      ? 'download_failed'
      : status === 'completed'
      ? 'ready'
      : status === 'downloading' || status === 'retrying'
      ? 'downloading'
      : 'idle';

  const isConverting = stage === 'converting';
  const convertTotal = progress?.convert_total ?? 0;
  const converted = progress?.converted ?? 0;
  const terminal = status === 'completed' || status === 'failed' || status === 'convert_failed' || status === 'cancelled';
  const verifiedFiles: string[] = progress?.verified_files ?? [];
  const sameLink = url.trim() === progress?.url;
  const retryKind = terminal && sameLink
    ? status === 'convert_failed'
      ? 'conversion'
      : progress?.failed > 0 || status === 'failed'
      ? 'download'
      : null
    : null;

  // Conversion shows a real converted/total percentage. Before ffmpeg has
  // reported anything countable there is no honest number, so the console runs
  // an indeterminate sweep rather than displaying a fabricated figure.
  const isIndeterminate = isConverting && !convertTotal;

  const percent = isConverting
    ? convertTotal
      ? (converted / convertTotal) * 100
      : 0
    : progress?.total_tracks
    ? (progress.current_track / progress.total_tracks) * 100
    : 0;

  const readoutTitle = isConverting
    ? (converted > 0 ? 'Converting to FLAC' : 'Downloaded, preparing FLAC')
    : stage === 'convert_failed'
    ? 'Conversion failed'
    : stage === 'ready'
    ? progress?.failed > 0 ? 'Some tracks are ready' : 'FLAC conversion complete'
    : stage === 'download_failed'
    ? (converted > 0 ? 'Some tracks are ready' : 'Download failed')
    : status === 'retrying'
    ? 'Retrying missing tracks'
    : isDownloading
    ? progress?.track_name || 'Preparing'
    : 'No signal';

  const readoutDetail = isConverting
    ? convertTotal
      ? `${converted} of ${convertTotal} converted · ${Math.max(0, convertTotal - converted)} pending`
      : 'Downloaded · FLAC conversion pending'
    : stage === 'convert_failed'
    ? progress?.convert_failed_tracks?.length
      ? `${progress.convert_failed_tracks.length} track(s) could not be converted`
      : 'Could not convert the download'
    : stage === 'ready'
    ? convertTotal
      ? `${converted} converted to FLAC${progress?.failed ? ` · ${progress.failed} need retry` : ' · saved to your library'}`
      : 'No new tracks needed conversion'
    : stage === 'download_failed'
    ? `${converted} FLAC ready · ${progress?.failed || 0} download errors`
    : status === 'retrying'
    ? `Attempt ${progress?.retry_attempt || 1} of ${progress?.retry_limit || 2} · ${progress?.failed || 0} pending`
    : isDownloading
    ? `Track ${progress?.current_track || 0} of ${progress?.total_tracks || '?'}`
    : isValidUrl
    ? 'Ready to download'
    : 'Waiting for a link';

  return (
    <div className="flex h-full min-h-0 animate-rise-in gap-6 pt-2">
      <div className="animate-slide-in-left">
        <DownloadConsole
          url={url}
          onUrlChange={setUrl}
          isDownloading={isDownloading}
          isValidUrl={isValidUrl}
          stage={stage}
          readoutTitle={readoutTitle}
          readoutDetail={readoutDetail}
          percent={percent}
          isIndeterminate={isIndeterminate}
          completed={progress?.completed || 0}
          failed={progress?.failed || 0}
          converted={converted}
          convertTotal={convertTotal}
          retryKind={retryKind}
          retryPrompt={Boolean(progress?.retry_prompt)}
          retryAttempts={progress?.retry_attempts || 0}
          error={error}
          onDownload={handleDownload}
          onQueue={handleQueue}
          onCancel={handleCancel}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {terminal && progress?.destination && (
          <section aria-label="Download result" className="glass relative max-h-[45%] shrink-0 space-y-2 overflow-auto rounded-2xl p-4 text-sm">
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
              <p role="status">{verifiedFiles.length} FLAC {verifiedFiles.length === 1 ? 'file' : 'files'} verified in your music folder</p>
              {electronAPI.openFolder && (
                <button type="button" className="rounded-lg border border-white/10 px-3 py-1.5 hover:bg-white/10"
                  onClick={() => void electronAPI.openFolder?.(progress.destination)}>
                  Open music folder
                </button>
              )}
            </div>
            <p className="relative z-10 break-all font-mono text-xs text-gray-300">{progress.destination}</p>
            {progress.file_error && <p role="alert" className="relative z-10 text-rose-300">{progress.file_error}</p>}
            {verifiedFiles.length > 0 && (
              <details className="relative z-10 text-xs text-gray-300">
                <summary className="cursor-pointer">Show file paths</summary>
                <ul className="mt-2 space-y-1">
                  {verifiedFiles.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
                </ul>
              </details>
            )}
          </section>
        )}
        <LogTerminal title="Download log" lines={logLines}
          idleHint="waiting for a download to start" className="min-h-0 min-w-0 flex-1" />
      </div>
    </div>
  );
}
