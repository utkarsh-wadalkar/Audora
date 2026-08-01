import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';

/**
 * LogTerminal — a CMD-styled, display-only live log.
 *
 * Shared by the setup wizard and the Download console so both surfaces read as
 * the same instrument. This is NOT a shell: there is no input and no command
 * execution. The `PS>` prompt and blinking cursor are affordances only.
 *
 * Auto-scroll follows the newest line but pauses the moment the user scrolls up
 * to read back, and resumes when they return to the bottom.
 */

/** Distance from the bottom (px) still treated as "at the bottom". */
const AT_BOTTOM_SLOP_PX = 24;

export interface LogLine {
  /** Monotonic id — lines are append-only, so this is a stable React key. */
  id: number;
  /** Wall-clock time the line was appended, pre-formatted for display. */
  timestamp: string;
  /** Log level or step status; drives the line colour. */
  level: string;
  /** Optional dimmed prefix, e.g. a setup step id. */
  prefix?: string;
  /** Already-redacted narration text. */
  text: string;
}

export interface LogTerminalProps {
  title: string;
  lines: LogLine[];
  /** Shown after the prompt when there is nothing to display yet. */
  idleHint: string;
  className?: string;
}

/** Per-level line colour. Errors and warnings must not rely on colour alone,
 *  so their level is also spelled out in the prefix column. */
function lineColor(level: string): string {
  if (level === 'error' || level === 'critical') return 'text-rose-300';
  if (level === 'warning' || level === 'warn') return 'text-amber-200';
  if (level === 'done' || level === 'success') return 'text-emerald-300';
  if (level === 'pending') return 'text-slate-500';
  return 'text-slate-300';
}

export default function LogTerminal({
  title,
  lines,
  idleHint,
  className = '',
}: LogTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Follow the newest line only while the user is parked at the bottom.
  useEffect(() => {
    if (!autoScroll) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setAutoScroll(distanceFromBottom <= AT_BOTTOM_SLOP_PX);
  };

  return (
    <div className={`glass flex flex-col overflow-hidden rounded-2xl ${className}`}>
      {/* Title bar — mimics a console window without pretending to be one. */}
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <Terminal size={13} className="text-audora-300" aria-hidden="true" />
        <span className="text-xs font-medium tracking-wide text-slate-200">{title}</span>
        {!autoScroll && (
          <span className="ml-auto text-[10px] text-slate-400">
            scrolled up — auto-scroll paused
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label={title}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-black/45 p-3 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-slate-500">
            <span className="text-audora-300">PS&gt;</span> {idleHint}
            <span className="ml-0.5 animate-cursor-blink text-slate-300">_</span>
          </div>
        ) : (
          lines.map((line, index) => (
            <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-slate-500">{line.timestamp}</span>
              <span className="shrink-0 text-audora-300">PS&gt;</span>
              <span className={lineColor(line.level)}>
                {line.prefix && <span className="text-slate-500">[{line.prefix}] </span>}
                {line.text}
                {/* Blinking cursor rides the newest line only. */}
                {index === lines.length - 1 && (
                  <span className="ml-0.5 animate-cursor-blink text-slate-300">_</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
