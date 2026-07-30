import { WifiOff } from 'lucide-react';

/**
 * OfflineBanner — a top-of-window notice shown only when Audora genuinely
 * cannot reach the internet and actually needs to.
 *
 * Deliberately narrow: it renders for the backend's `offline` taxonomy code
 * only. Docker being down, a full disk and an auth rejection all have their own
 * codes and their own recovery UI, so none of them raise this. A
 * fully-provisioned start needs no network at all and therefore never surfaces
 * it either — the backend only classifies offline on a step that actually tried
 * to reach the network and failed.
 *
 * It clears itself: `offline` is a transient code, so setup keeps auto-retrying
 * and the next successful attempt moves the step off `error`, which unmounts
 * this. No dismiss button, because dismissing would not change the condition.
 */
export default function OfflineBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2.5 border-b border-amber-900/50 bg-amber-950/95 px-4 py-2.5 text-sm text-amber-100 shadow-lg backdrop-blur"
    >
      <WifiOff size={15} className="shrink-0 text-amber-300" />
      <span className="font-medium">Please connect to the internet.</span>
      <span className="text-amber-200/80">
        Setup will continue automatically once you&apos;re back online.
      </span>
    </div>
  );
}
