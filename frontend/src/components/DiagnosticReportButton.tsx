import { useState } from 'react';
import { ClipboardCopy, Check, Loader2 } from 'lucide-react';
import { api } from '../api/client';

/**
 * DiagnosticReportButton (QC_plan.md §8.2, Workstream F).
 *
 * A self-contained "Copy diagnostic report" button. Per §8.2 it is meant to
 * appear once a setup step reaches a *visible* failure state (after silent
 * auto-retries are exhausted) — but the actual placement/trigger wiring into
 * the wizard is Workstream E's job. This component only knows how to fetch +
 * copy the bundle; the parent decides when to render it.
 *
 * On click it hits the pure-read backend endpoint, copies the formatted
 * `report` text block to the clipboard, and shows a brief "Copied" state.
 * Never a dead end (§1.6): if the request fails it still copies whatever
 * message it can and surfaces a non-blocking error label — never a silent
 * failure.
 */
export default function DiagnosticReportButton({
  failedStep,
  className = '',
}: {
  /** Optional id of the failed step, purely for the caller's context. */
  failedStep?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'copied' | 'error'>('idle');

  const copyReport = async () => {
    setState('loading');
    let report = '';
    try {
      const r = await api.get('/setup/diagnostics');
      report = r.data?.data?.report || '';
    } catch (e) {
      // Never a dead end: fall back to a minimal report the user can still send.
      report =
        '=== Audora Diagnostic Report ===\n' +
        `Failed step: ${failedStep || 'unknown'}\n` +
        'Could not reach the backend to gather full diagnostics.';
    }
    try {
      await navigator.clipboard.writeText(report);
      setState('copied');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      setState('error');
      setTimeout(() => setState('idle'), 2500);
    }
  };

  return (
    <button
      onClick={copyReport}
      disabled={state === 'loading'}
      className={
        'inline-flex items-center gap-2 rounded-xl border border-white/[0.10] bg-white/[0.04] ' +
        'px-4 py-2.5 text-sm text-gray-200 transition-colors hover:bg-white/[0.07] ' +
        'disabled:opacity-50 ' +
        className
      }
    >
      {state === 'loading' ? (
        <Loader2 size={14} className="animate-spin text-audora-300" />
      ) : state === 'copied' ? (
        <Check size={14} className="text-emerald-400" />
      ) : (
        <ClipboardCopy size={14} className="text-audora-300" />
      )}
      {state === 'copied'
        ? 'Copied to clipboard'
        : state === 'error'
        ? 'Copy failed — try again'
        : 'Copy diagnostic report'}
    </button>
  );
}
