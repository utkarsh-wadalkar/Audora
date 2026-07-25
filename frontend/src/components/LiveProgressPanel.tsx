import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal } from 'lucide-react';

/**
 * LiveProgressPanel — Workstream D of the setup-wizard reliability rework.
 *
 * Purely presentational. Every number it renders is DERIVED from the event
 * data passed in via props — it never simulates or fabricates progress. The
 * only internal state it keeps is timing/smoothing bookkeeping (a rolling
 * window of real byte-total observations) used to compute speed + ETA per
 * QC_plan §5.3. When it is fed no events, it shows a "preparing" state rather
 * than a frozen blank (QC_plan §1.1 "never a dead end").
 *
 * Spec references: QC_plan.md §3.3 (event JSON shape), §5 (aggregate bar,
 * per-layer rows, speed+ETA, engagement), §8.1 (expandable terminal log).
 */

// ---------------------------------------------------------------------------
// Event shape — matches QC_plan §3.3 exactly:
//   {"status": "Downloading", "progressDetail": {"current": …, "total": …}, "id": "a1b2c3d4"}
// ---------------------------------------------------------------------------
export interface PullProgressDetail {
  current: number;
  total: number;
}

export interface PullEvent {
  status: string;
  id?: string;
  progressDetail?: PullProgressDetail;
}

/**
 * Prop contract: the panel receives the LATEST-PER-LAYER event array. That is,
 * the caller (Workstream E's ws/setup handler, or the mock harness) collapses
 * the raw event stream so there is exactly one entry per layer id, reflecting
 * that layer's most recent status. This mirrors how the Docker CLI keeps one
 * line per layer, updating in place. The panel renders directly from it.
 */
export interface LiveProgressPanelProps {
  /** Latest event per layer, keyed implicitly by `id`. */
  layers: PullEvent[];
  /** Optional plain-language narration line (QC_plan §4.3). */
  narration?: string;
}

// A layer is "done" (fully downloaded/extracted) when Docker reports one of
// these terminal statuses. We treat these as 100% for aggregate purposes.
const TERMINAL_STATUSES = new Set([
  'Pull complete',
  'Already exists',
  'Download complete',
]);

// Statuses that carry meaningful byte progress.
const isByteStatus = (status: string) =>
  status === 'Downloading' || status === 'Extracting';

// ---------------------------------------------------------------------------
// Formatting helpers — all pure.
// ---------------------------------------------------------------------------

/** Format a byte count like `123 MB` (Docker-style, base-1000, human units). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // Whole numbers for B/KB/MB, one decimal for GB+ to stay readable.
  const digits = unit >= 3 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Format an ETA in seconds to a human phrase, per QC_plan §5.3:
 * round to a sensible unit; NEVER show raw seconds for anything over 90s.
 * Never returns a negative / NaN estimate — the caller guarantees a finite,
 * non-negative input, and we clamp defensively anyway.
 */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'Almost done';
  if (seconds <= 90) {
    const s = Math.max(1, Math.round(seconds));
    return `About ${s} second${s === 1 ? '' : 's'} remaining`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `About ${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
  }
  const hours = Math.round(seconds / 3600);
  return `About ${hours} hour${hours === 1 ? '' : 's'} remaining`;
}

/** Format a speed in bytes/sec like `4.2 MB/s`. */
function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

// ---------------------------------------------------------------------------
// Aggregate derivation — pure. Sums real byte counts across all layers.
// ---------------------------------------------------------------------------
interface Aggregate {
  current: number;
  total: number;
  percent: number; // 0..100
  hasBytes: boolean; // any layer reported byte totals yet?
}

function deriveAggregate(layers: PullEvent[]): Aggregate {
  let current = 0;
  let total = 0;
  let hasBytes = false;

  for (const layer of layers) {
    const detail = layer.progressDetail;
    if (detail && detail.total > 0) {
      hasBytes = true;
      // A layer that has reached a terminal status counts as fully complete
      // even if its last byte event lagged behind `total`.
      const done = TERMINAL_STATUSES.has(layer.status);
      current += done ? detail.total : Math.min(detail.current, detail.total);
      total += detail.total;
    } else if (TERMINAL_STATUSES.has(layer.status)) {
      // Terminal layer with no byte detail (e.g. "Already exists"): it
      // contributes nothing to the byte-based aggregate, but it is complete.
    }
  }

  const percent = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  return { current, total, percent, hasBytes };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LiveProgressPanel({ layers, narration }: LiveProgressPanelProps) {
  const [showDetails, setShowDetails] = useState(false);

  const aggregate = useMemo(() => deriveAggregate(layers), [layers]);

  // --- Rolling-window speed + ETA (QC_plan §5.3) -------------------------
  // We record (timestamp, totalDownloadedBytes) samples as real aggregate
  // byte counts arrive, and keep only the last ~5s. Speed is derived as the
  // byte delta over the time delta across that window — smoothed, real data
  // only. No sample is invented; if `layers` never changes, no sample is
  // pushed and the last speed simply ages out to empty.
  const SMOOTHING_MS = 5000;
  const samplesRef = useRef<{ t: number; bytes: number }[]>([]);
  const [speed, setSpeed] = useState(0); // bytes/sec
  const lastBytesRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    const bytes = aggregate.current;

    // Only record a sample when the real byte total actually moved, so a
    // static render doesn't fabricate a "0 delta" that would wrongly zero the
    // speed. (An unchanged aggregate genuinely means no new bytes, but we
    // still let old samples age out below via the window trim.)
    if (bytes !== lastBytesRef.current) {
      lastBytesRef.current = bytes;
      samplesRef.current.push({ t: now, bytes });
    }

    // Trim to the smoothing window.
    const cutoff = now - SMOOTHING_MS;
    samplesRef.current = samplesRef.current.filter((s) => s.t >= cutoff);

    const samples = samplesRef.current;
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      const db = last.bytes - first.bytes;
      // Guard against div-by-zero and any backward byte movement.
      setSpeed(dt > 0 && db > 0 ? db / dt : 0);
    } else {
      setSpeed(0);
    }
  }, [aggregate.current]);

  // ETA from the smoothed speed and REAL remaining bytes (QC_plan §5.3):
  //   eta_seconds = (total - downloaded) / rolling_average_speed
  const remaining = Math.max(0, aggregate.total - aggregate.current);
  const etaSeconds = speed > 0 ? remaining / speed : NaN;
  const etaLabel = formatEta(etaSeconds);
  const speedLabel = formatSpeed(speed);

  const isComplete =
    aggregate.hasBytes && aggregate.percent >= 100 && remaining === 0;

  // "Preparing" state: we have no layers or no byte totals yet. Never blank.
  const preparing = layers.length === 0 || !aggregate.hasBytes;

  return (
    <div className="w-full bg-gray-900 rounded-2xl border border-gray-800 p-6 space-y-4 text-gray-100">
      {/* Narration line (QC_plan §4.3 / §5.4) */}
      <div className="flex items-center gap-2 text-sm text-gray-300 min-h-[20px]">
        {!isComplete && (
          <Loader2 size={16} className="animate-spin text-violet-400 shrink-0" />
        )}
        <span className="truncate">
          {narration ??
            (preparing
              ? 'Preparing download — contacting the download server...'
              : isComplete
              ? 'Download complete.'
              : 'Downloading required components...')}
        </span>
      </div>

      {/* Aggregate progress bar (QC_plan §5.2) */}
      <div className="space-y-2">
        <div className="h-2.5 w-full rounded-full bg-gray-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-300 ease-out"
            style={{ width: `${preparing ? 0 : aggregate.percent}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-gray-400">
          <span className="tabular-nums">
            {preparing
              ? 'Preparing...'
              : `${formatBytes(aggregate.current)} / ${formatBytes(aggregate.total)}`}
          </span>
          <span className="tabular-nums">
            {preparing ? '' : `${Math.floor(aggregate.percent)}%`}
          </span>
        </div>

        {/* Speed + ETA (QC_plan §5.3) — only when we have a real estimate. */}
        <div className="flex items-center justify-between text-xs min-h-[16px]">
          <span className="text-gray-500 tabular-nums">{speedLabel}</span>
          <span className="text-violet-300">
            {isComplete ? '' : etaLabel}
          </span>
        </div>
      </div>

      {/* Expandable "Show details" toggle (QC_plan §8.1) */}
      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
      >
        {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Terminal size={13} className="text-gray-500" />
        {showDetails ? 'Hide details' : 'Show details'}
      </button>

      {/* Terminal-styled per-layer log (QC_plan §3.3, §8.1). One line per
          layer, updating in place — never appended duplicates. */}
      {showDetails && (
        <div className="rounded-lg bg-black/80 border border-gray-800 p-3 font-mono text-[11px] leading-relaxed overflow-x-auto">
          {layers.length === 0 ? (
            <div className="text-gray-600">Waiting for layer information...</div>
          ) : (
            layers.map((layer) => (
              <LayerLine key={layer.id ?? layer.status} layer={layer} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single terminal-style layer line, Docker-CLI-like:
//   a1b2c3d4: Downloading  [====>       ]  52 MB / 200 MB
// ---------------------------------------------------------------------------
function LayerLine({ layer }: { layer: PullEvent }) {
  const shortId = (layer.id ?? '········').slice(0, 12);
  const detail = layer.progressDetail;
  const done = TERMINAL_STATUSES.has(layer.status);

  // Color the status like the CLI's semantic coloring.
  const statusColor = done
    ? 'text-green-400'
    : layer.status === 'Extracting'
    ? 'text-amber-300'
    : layer.status === 'Downloading'
    ? 'text-violet-300'
    : 'text-gray-400';

  // Byte-based bar, only when this layer reports byte progress.
  let bar: string | null = null;
  let bytesLabel: string | null = null;
  if (detail && detail.total > 0 && isByteStatus(layer.status)) {
    const ratio = Math.min(1, detail.current / detail.total);
    const width = 12;
    const filled = Math.round(ratio * width);
    bar = `[${'='.repeat(Math.max(0, filled - 1))}${filled > 0 && filled < width ? '>' : filled >= width ? '=' : ''}${' '.repeat(width - filled)}]`;
    bytesLabel = `${formatBytes(detail.current)} / ${formatBytes(detail.total)}`;
  }

  return (
    <div className="whitespace-pre text-gray-300">
      <span className="text-gray-500">{shortId}: </span>
      <span className={statusColor}>{layer.status.padEnd(14, ' ')}</span>
      {bar && <span className="text-gray-600">{bar} </span>}
      {bytesLabel && <span className="text-gray-400">{bytesLabel}</span>}
    </div>
  );
}
