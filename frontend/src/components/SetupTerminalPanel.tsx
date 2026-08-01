import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { SetupStepStatus } from '../store/useAppStore';

/**
 * SetupTerminalPanel — a CMD-styled, display-only live log beside the wizard.
 *
 * It renders one line per `/ws/setup` event so the user watches real progress
 * scroll past instead of staring at an indeterminate spinner. This is NOT a
 * shell: there is no input, no command execution, and nothing here can affect
 * the backend. The `PS>` prompt and blinking cursor are affordances only.
 *
 * Auto-scroll follows the newest line, but pauses the moment the user scrolls
 * up to read back, and resumes when they return to the bottom.
 */

/** Max retained lines. Bounded so a long session cannot grow without limit. */
export const TERMINAL_MAX_LINES = 2000;

/** Distance from the bottom (px) still treated as "at the bottom". */
const AT_BOTTOM_SLOP_PX = 24;

export interface TerminalLine {
  /** Monotonic id — lines are append-only, so this is a stable React key. */
  id: number;
  /** Wall-clock time the line was appended, pre-formatted for display. */
  timestamp: string;
  /** The event's step id, shown dimmed as a prefix. */
  step: string;
  /** Status that produced this line; drives the line colour. */
  status: SetupStepStatus;
  /** Already-redacted narration text from the event's `message` field. */
  text: string;
}

export interface SetupTerminalPanelProps {
  lines: TerminalLine[];
  /** Extra classes for the outer element, e.g. flex sizing from the parent. */
  className?: string;
}

/** Per-status line colour, reusing the palette from the glass redesign. */
function lineColor(status: SetupStepStatus): string {
  if (status === 'error') return 'text-rose-400';
  if (status === 'done') return 'text-emerald-400';
  if (status === 'running') return 'text-gray-300';
  return 'text-gray-600';
}

export default function SetupTerminalPanel({
  lines,
  className = '',
}: SetupTerminalPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Follow the newest line only while the user is parked at the bottom.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom <= AT_BOTTOM_SLOP_PX);
  };

  return (
    <div
      className={
        'flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] ' +
        'bg-black/25 shadow-glass ' +
        className
      }
    >
      {/* Title bar — mimics a console window without pretending to be one. */}
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <Terminal size={14} className="text-audora-300" />
        <span className="text-xs font-medium text-gray-300">Setup log</span>
        {!autoScroll && (
          <span className="ml-auto text-[10px] text-gray-500">
            scrolled up — auto-scroll paused
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-black/80 p-3 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-gray-600">
            <span className="text-audora-300">PS&gt;</span> waiting for setup to
            start
            <span className="ml-0.5 animate-pulse text-gray-400">_</span>
          </div>
        ) : (
          <>
            {lines.map((line, index) => (
              <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-words">
                <span className="shrink-0 text-gray-600">{line.timestamp}</span>
                <span className="shrink-0 text-audora-300">PS&gt;</span>
                <span className={lineColor(line.status)}>
                  <span className="text-gray-600">[{line.step}]</span> {line.text}
                  {/* Blinking cursor rides the newest line only. */}
                  {index === lines.length - 1 && (
                    <span className="ml-0.5 animate-pulse text-gray-400">_</span>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
