import { useState, useRef } from 'react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore } from '../store/useAppStore';
import DownloadConsole from '../components/DownloadConsole';
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
  const [format, setFormat] = useState('alac');
  const [isDownloading, setIsDownloading] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<any>(null);
  const [error, setError] = useState('');

  // Monotonic id so append-only lines get stable React keys.
  const nextLineId = useRef(0);

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
      setProgress(data);
      if (
        data?.status === 'completed' ||
        data?.status === 'failed' ||
        data?.status === 'cancelled'
      ) {
        setIsDownloading(false);
      } else if (data?.status === 'downloading') {
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
    setIsDownloading(true);
    setLogLines([]);
    setProgress(null);
    try {
      const response = await api.post('/download', { url, format });
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

  const percent = progress?.total_tracks
    ? (progress.current_track / progress.total_tracks) * 100
    : 0;

  const readoutTitle = isDownloading
    ? progress?.track_name || 'Preparing'
    : progress?.status === 'completed'
    ? 'Download complete'
    : 'No signal';

  const readoutDetail = isDownloading
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
          format={format}
          onFormatChange={setFormat}
          isDownloading={isDownloading}
          isValidUrl={isValidUrl}
          readoutTitle={readoutTitle}
          readoutDetail={readoutDetail}
          percent={percent}
          completed={progress?.completed || 0}
          failed={progress?.failed || 0}
          error={error}
          onDownload={handleDownload}
          onQueue={handleQueue}
          onCancel={handleCancel}
        />
      </div>

      <LogTerminal
        title="Download log"
        lines={logLines}
        idleHint="waiting for a download to start"
        className="min-w-0 flex-1"
      />
    </div>
  );
}
