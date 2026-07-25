import { useState } from 'react';
import { RefreshCw, Play, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { SetupStepError } from '../store/useAppStore';

/**
 * RetryButton (QC_plan.md §1 principle 1, §6.3, §7 — Workstream E).
 *
 * The SINGLE primary recovery action for a setup step that has surfaced a
 * visible failure (`status === 'error'`). Per the "never a dead end" rule
 * there is EXACTLY ONE such button, and its label/behavior is chosen from the
 * error taxonomy code — never a raw error with no action, never two competing
 * recovery paths, and NEVER an instruction to open a terminal or paste a
 * command (constraint 3).
 *
 * Clicking it re-invokes the idempotent backend re-trigger (`POST
 * /setup/images`, Workstream B) which moves the failed step back to running;
 * the live `/ws/setup` stream then drives the step forward again. Because the
 * backend re-trigger is idempotent (§6.4) it is safe to click repeatedly —
 * a partially-pulled image resumes rather than restarts.
 *
 * The `docker_unresponsive` case additionally asks the backend to nudge Docker
 * (via `POST /docker/start` if available) before re-running setup, so the fix
 * stays fully in-app. If that endpoint is unavailable the retry still proceeds
 * (the backend polls for Docker readiness itself), so the button is never a
 * dead end.
 */

interface RecoveryPlan {
  label: string;
  /** Extra guidance line shown above the button for actionable-but-not-in-app
   *  fixes (e.g. free disk space). Never contains a command to run. */
  guidance?: string;
  /** Whether to attempt an in-app Docker start before re-running setup. */
  startDocker?: boolean;
}

/**
 * Map an error taxonomy code (backend `error.code`) to its single recovery
 * action. Every code resolves to exactly one primary button — unknown/missing
 * codes fall through to a generic "Try Again".
 */
export function recoveryForError(error?: SetupStepError): RecoveryPlan {
  switch (error?.code) {
    case 'docker_unresponsive':
      return { label: 'Start Docker & Retry', startDocker: true };
    case 'dns_failure':
    case 'registry_rate_limit':
    case 'registry_unavailable':
      return { label: 'Try Again' };
    case 'disk_full':
      return {
        label: 'Try Again',
        guidance:
          'Audora needs more free disk space to continue. Free up some space on your Docker drive, then try again.',
      };
    case 'auth_denied':
      return {
        label: 'Try Again',
        guidance:
          'Audora could not access what it needs to finish setup. Make sure Docker Desktop is running and signed in, then try again.',
      };
    case 'unknown':
    default:
      return { label: 'Try Again' };
  }
}

export default function RetryButton({
  error,
  onRetry,
  className = '',
}: {
  /** The failed step's error classification (drives the label). */
  error?: SetupStepError;
  /** Called after the re-trigger request is dispatched (e.g. to reset UI). */
  onRetry?: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const plan = recoveryForError(error);

  const handleRetry = async () => {
    setBusy(true);
    try {
      // Best-effort in-app Docker nudge for the docker_unresponsive case.
      // Never blocks or dead-ends the retry if the endpoint is absent.
      if (plan.startDocker) {
        try {
          await api.post('/docker/start');
        } catch {
          // Backend polls Docker readiness on its own; proceed regardless.
        }
      }
      // Idempotent re-trigger (Workstream B, §6.4): safe to click repeatedly.
      // Re-runs the exact same setup code path, moving the failed step to
      // running; progress resumes over `/ws/setup`.
      await api.post('/setup/images');
      onRetry?.();
    } catch {
      // Surface nothing scary — the step stays in its error state with this
      // same single button, so the user can simply click again. Never a
      // dead end, never a terminal instruction.
    } finally {
      setBusy(false);
    }
  };

  const Icon = plan.startDocker ? Play : RefreshCw;

  return (
    <div className="space-y-2">
      {plan.guidance && <p className="text-sm text-gray-300">{plan.guidance}</p>}
      <button
        onClick={handleRetry}
        disabled={busy}
        className={
          'inline-flex items-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 ' +
          'disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors ' +
          className
        }
      >
        {busy ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Icon size={15} />
        )}
        {plan.label}
      </button>
    </div>
  );
}
