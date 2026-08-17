import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Loader2, Music, Download as DownloadIcon, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore, type SetupProgressEvent, type SetupStepState } from '../store/useAppStore';
import LiveProgressPanel, { type PullEvent } from './LiveProgressPanel';
import RetryButton from './RetryButton';
import DiagnosticReportButton from './DiagnosticReportButton';
import SetupTerminalPanel, {
  TERMINAL_MAX_LINES,
  type TerminalLine,
} from './SetupTerminalPanel';
import OfflineBanner from './OfflineBanner';

interface SystemCheck {
  windows: { ok: boolean; label: string };
  docker: { installed: boolean; running: boolean; download_url: string };
  wsl2: { ok: boolean };
  images: { downloader: boolean; wrapper: boolean };
}

type Screen = 'welcome' | 'system' | 'images' | 'signin' | 'done';

// Image-setup steps in orchestration order (backend setup_manager). The final
// "complete" bookkeeping step is not shown as its own row — it just gates the
// Continue action.
const IMAGE_STEPS: { id: string; label: string; narration: string }[] = [
  {
    id: 'pull_downloader',
    label: 'apple-music-downloader',
    narration:
      'Downloading the track downloader — this is the component that fetches your music.',
  },
  {
    id: 'build_downloader',
    label: 'FLAC support',
    narration:
      'Preparing FLAC conversion — this is what makes your downloads playable in Audora.',
  },
  {
    id: 'build_wrapper',
    label: 'wrapper image',
    narration:
      'Downloading the decryption service (wrapper) — this lets Audora talk securely to Apple Music.',
  },
];

// Persistent breadcrumb (QC_plan §4.1).
const BREADCRUMBS: { screen: Screen; label: string }[] = [
  { screen: 'system', label: 'Checking system' },
  { screen: 'images', label: 'Downloading components' },
  { screen: 'signin', label: 'Sign in' },
  { screen: 'done', label: 'Done' },
];

// A short, plain-language headline per error taxonomy code (QC_plan §7.1).
// The single recovery button + its behavior lives in <RetryButton>; this is
// only the narration of what went wrong.
function failureHeadline(step: SetupStepState): string {
  const code = step.error?.code;
  switch (code) {
    case 'docker_unresponsive':
      return 'Docker is still starting up and stopped responding.';
    case 'dns_failure':
      return 'Having trouble reaching the download server.';
    case 'offline':
      return 'No internet connection.';
    case 'registry_rate_limit':
      return 'The download server is temporarily busy.';
    case 'registry_unavailable':
      return 'The download server is temporarily unavailable.';
    case 'disk_full':
      return 'Not enough free disk space to continue.';
    case 'auth_denied':
      return 'Audora was denied access while setting up.';
    case 'unknown':
    default:
      return step.message || 'Something went wrong downloading a required component.';
  }
}

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [check, setCheck] = useState<SystemCheck | null>(null);

  // Setup-step state lives in the store (state machine §6.1). Reading it here
  // keeps the wizard a thin view over real event-driven state.
  const setupSteps = useAppStore((s) => s.setupSteps);
  const applySetupEvent = useAppStore((s) => s.applySetupEvent);
  const seedSetupSteps = useAppStore((s) => s.seedSetupSteps);

  // Sign-in state (mirrors LoginModal, inlined here). Unchanged auth flow.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [authMsg, setAuthMsg] = useState('');
  const [authErr, setAuthErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showingWrapperLogs, setShowingWrapperLogs] = useState(false);

  // --- No-late-join-replay seed (Workstream C flag 1) ----------------------
  // `/ws/setup` never replays state that already happened, so on mount AND on
  // every (re)connect we pull `GET /setup/status` and seed the step slice from
  // it. This guarantees a reload or a socket drop mid-setup never shows a
  // blank/frozen panel — already-present images seed as "done", the rest as
  // "pending", and any live step already in the store is left untouched.
  const seedFromStatus = useMemo(
    () => async () => {
      try {
        const r = await api.get('/setup/status');
        seedSetupSteps(r.data?.data ?? {});
      } catch {
        // Backend not up yet — leave whatever we have; the ws stream (once it
        // connects) and a later reconnect re-seed will fill it in.
      }
    },
    [seedSetupSteps],
  );

  // Seed once on mount.
  useEffect(() => {
    seedFromStatus();
  }, [seedFromStatus]);

  // Append-only log for the terminal panel. The store keys steps by id and
  // overwrites, which is right for the step rows but loses history — the
  // terminal needs every event in arrival order, so it accumulates separately.
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const lineIdRef = useRef(0);
  // Dedupe guard for reconnects: /ws/setup has no server-side replay, but a
  // drop-and-resume can redeliver the frame that was in flight. Keying on
  // step+status+message means an identical consecutive frame is not repeated.
  const lastLineKeyRef = useRef<string>('');
  const wrapperLogSequenceRef = useRef(0);
  const wrapperLogStartSequenceRef = useRef(Number.MAX_SAFE_INTEGER);
  const wrapperLogRenderedSequenceRef = useRef(0);
  const wrapperLogActiveRef = useRef(false);

  const appendTerminalLine = (event: SetupProgressEvent) => {
    const text = event.message;
    // The backend documents `message` as always present, but the type marks it
    // optional — skip rather than printing "undefined".
    if (!text) return;

    const key = `${event.step}|${event.status}|${text}`;
    if (key === lastLineKeyRef.current) return;
    lastLineKeyRef.current = key;

    const now = new Date();
    const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');

    setTerminalLines((prev) => [
      ...prev.slice(-(TERMINAL_MAX_LINES - 1)),
      {
        id: (lineIdRef.current += 1),
        timestamp,
        step: event.step,
        status: event.status,
        text,
      },
    ]);
  };

  const appendWrapperLogLine = (sequence: number, text: string) => {
    if (
      sequence <= wrapperLogStartSequenceRef.current ||
      sequence <= wrapperLogRenderedSequenceRef.current
    ) {
      return;
    }
    wrapperLogRenderedSequenceRef.current = sequence;
    const now = new Date();
    const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    setTerminalLines((prev) => [
      ...prev.slice(-(TERMINAL_MAX_LINES - 1)),
      {
        id: (lineIdRef.current += 1),
        timestamp,
        step: 'wrapper',
        status: 'running',
        text,
        raw: true,
      },
    ]);
  };

  // Subscribe to the live event stream and funnel every event into the store.
  // On (re)connect (readyState → 'open') we re-seed from REST so no state is
  // lost across a drop — the seed only fills gaps and never downgrades a live
  // step.
  const { readyState } = useWebSocket('/ws/setup', {
    onMessage: (data) => {
      if (data?.type === 'setup_progress') {
        const event = data as SetupProgressEvent;
        applySetupEvent(event);
        if (!wrapperLogActiveRef.current) appendTerminalLine(event);
      }
    },
  });

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (readyState === 'open' && !wasOpenRef.current) {
      // Re-seed on each fresh open (initial + each reconnect after a drop).
      seedFromStatus();
      wasOpenRef.current = true;
    } else if (readyState === 'closed') {
      wasOpenRef.current = false;
    }
  }, [readyState, seedFromStatus]);

  useWebSocket('/ws/auth', {
    onMessage: (data) => {
      if (data?.type === 'auth_2fa_required') {
        setNeed2fa(true);
        setAuthMsg(data.message);
        setBusy(false);
      } else if (data?.type === 'auth_success') {
        setAuthMsg(data.message);
        setBusy(false);
        setScreen('done');
      } else if (data?.type === 'auth_error') {
        setAuthErr(data.message);
        setBusy(false);
      } else if (data?.type === 'auth_progress') {
        setAuthMsg(data.message);
      } else if (data?.type === 'auth_credentials_required') {
        setNeed2fa(false);
        setAuthMsg(data.message);
        setBusy(false);
      }
    },
  });

  useWebSocket('/ws/wrapper', {
    onMessage: (data) => {
      if (data?.type !== 'wrapper_log') return;
      const sequence = Number(data.sequence) || 0;
      wrapperLogSequenceRef.current = Math.max(
        wrapperLogSequenceRef.current,
        sequence,
      );
      if (wrapperLogActiveRef.current) {
        appendWrapperLogLine(sequence, String(data.line ?? ''));
      }
    },
  });

  const runCheck = async () => {
    const r = await api.post('/setup/check');
    setCheck(r.data.data);
  };

  useEffect(() => {
    if (screen === 'system') runCheck();
  }, [screen]);

  const startImages = async () => {
    setScreen('images');
    await api.post('/setup/images');
  };

  const submitCreds = async () => {
    if (!email || !password) {
      setAuthErr('Enter your Apple ID and password.');
      return;
    }
    setAuthErr('');
    setBusy(true);
    setAuthMsg('Connecting to Apple Music...');
    await api.post('/auth/login', { email, password });
  };

  const startWrapperForSetup = async () => {
    wrapperLogStartSequenceRef.current = wrapperLogSequenceRef.current;
    wrapperLogRenderedSequenceRef.current = wrapperLogSequenceRef.current;
    wrapperLogActiveRef.current = true;
    setShowingWrapperLogs(true);
    lastLineKeyRef.current = '';
    setTerminalLines([]);
    setScreen('signin');
    setNeed2fa(false);
    setAuthErr('');
    setAuthMsg('Checking the saved Apple Music session...');
    setBusy(true);

    try {
      const response = await api.post('/setup/wrapper', {}, { timeout: 65000 });
      const state = response.data?.data?.state;
      setBusy(false);
      if (state === 'authenticated') {
        setAuthMsg('Saved session detected.');
        setScreen('done');
      } else if (state === 'needs_2fa') {
        setNeed2fa(true);
        setAuthMsg('Enter your 6-digit verification code');
      } else if (state === 'needs_credentials') {
        setNeed2fa(false);
        setAuthMsg('Sign in once; the wrapper will cache this session locally.');
      } else {
        setAuthErr('The Apple Music wrapper did not reach a usable state.');
      }
    } catch (error: any) {
      setBusy(false);
      setAuthErr(
        error?.response?.data?.error ||
          'Could not start the Apple Music wrapper. Check the live log for details.',
      );
    }
  };

  const submit2fa = async () => {
    // Validate before sending: the wrapper consumes the code file the instant
    // it appears, so an empty or partial submission burns the user's single
    // attempt and drops them back to the start of the sign-in.
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setAuthErr('Verification code cannot be empty.');
      return;
    }
    if (trimmedCode.length < 6) {
      setAuthErr('Enter all 6 digits of your verification code.');
      return;
    }
    setAuthErr('');
    setBusy(true);
    const response = await api.post('/auth/2fa', { code: trimmedCode });
    // The backend rejects a malformed code without writing it, so surface that
    // instead of leaving the user waiting on a code that was never submitted.
    if (response.data?.success === false) {
      setBusy(false);
      setAuthErr('That code was not accepted. Please check it and try again.');
    }
  };

  const finish = async () => {
    await api.post('/setup/complete');
    onComplete();
  };

  const Row = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-2.5 text-sm">
      {ok ? (
        <Check size={15} className="shrink-0 text-emerald-400" />
      ) : (
        <X size={15} className="shrink-0 text-rose-400" />
      )}
      <span className={ok ? 'text-gray-200' : 'text-gray-400'}>{label}</span>
    </div>
  );

  // --- Derived image-step view -------------------------------------------
  const downloaderStep = setupSteps['pull_downloader'];
  // Gate on EVERY image step rather than a hand-listed pair, so adding a step
  // to IMAGE_STEPS cannot let the wizard advance before that step finishes.
  const bothDone = IMAGE_STEPS.every(
    (step) => setupSteps[step.id]?.status === 'done',
  );

  // The single step (if any) currently in a surfaced failure state. Only the
  // active/first failed step drives the failure UI — exactly one recovery path.
  const failedStepId = IMAGE_STEPS.find(
    (s) => setupSteps[s.id]?.status === 'error',
  )?.id;
  const failedStep = failedStepId ? setupSteps[failedStepId] : undefined;

  // Offline banner: driven solely by the backend's `offline` taxonomy code, so
  // it cannot misfire on a Docker outage, a full disk or an auth rejection —
  // those carry their own codes. A fully-provisioned start never reaches a
  // network step, so it never surfaces this either. Because `offline` is
  // transient the backend keeps retrying, and the banner disappears by itself
  // when an attempt finally succeeds and the step leaves `error`.
  const isOffline = failedStep?.error?.code === 'offline';

  // The step currently being pulled (running) — drives the LiveProgressPanel.
  // We surface the downloader's aggregate byte progress; the wrapper build has
  // no byte stream, so the panel narrates it as "preparing"/running.
  const activeStepId = IMAGE_STEPS.find(
    (s) => setupSteps[s.id]?.status === 'running',
  )?.id;
  const activeStep = activeStepId ? setupSteps[activeStepId] : undefined;

  // Package the REAL aggregate byte counts from the store into the panel's
  // per-layer prop as a single aggregate "layer" (Workstream C flag 2: the
  // event carries aggregate progress only, never per-layer rows). No fake
  // data — bytes come straight from the `progress` field of the event.
  const panelLayers: PullEvent[] = useMemo(() => {
    // Prefer the running step; if the downloader is already done but the
    // wrapper is still going, show the downloader as complete.
    const src = activeStep ?? downloaderStep;
    if (!src) return [];
    if (src.status === 'done') {
      const total = src.progress?.total ?? 0;
      return total > 0
        ? [{ status: 'Pull complete', id: 'aggregate', progressDetail: { current: total, total } }]
        : [{ status: 'Pull complete', id: 'aggregate' }];
    }
    if (src.progress && src.progress.total > 0) {
      return [
        {
          status: 'Downloading',
          id: 'aggregate',
          progressDetail: {
            current: src.progress.current,
            total: src.progress.total,
          },
        },
      ];
    }
    // Running but no byte data yet (e.g. preflight / wrapper build): let the
    // panel show its "preparing" state rather than a blank.
    return [];
  }, [activeStep, downloaderStep]);

  const panelNarration =
    activeStepId
      ? IMAGE_STEPS.find((s) => s.id === activeStepId)?.narration
      : bothDone
      ? 'All components downloaded.'
      : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-void p-8">
      <OfflineBanner visible={isOffline} />
      {/* Two columns: the wizard keeps its fixed width, the terminal takes the
          rest. `items-stretch` + max-h on the panel keeps a long log from
          growing the row and pushing the card off-screen. */}
      <div className="flex w-full max-w-5xl items-stretch justify-center gap-6">
        <div className="glass w-full max-w-lg shrink-0 rounded-3xl p-8">
        {/* Persistent breadcrumb (QC_plan §4.1) — hidden on the welcome splash. */}
        {screen !== 'welcome' && (
          <div className="flex items-center gap-1.5 mb-6 text-[11px] flex-wrap">
            {BREADCRUMBS.map((b, i) => {
              const order: Screen[] = ['system', 'images', 'signin', 'done'];
              const current = order.indexOf(screen);
              const idx = order.indexOf(b.screen);
              const isCurrent = idx === current;
              const isDone = idx < current;
              return (
                <div key={b.screen} className="flex items-center gap-1.5">
                  <span
                    className={
                      'relative z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 ' +
                      (isCurrent
                        ? 'bg-audora-500/25 font-medium text-audora-100'
                        : isDone
                        ? 'text-emerald-400'
                        : 'text-gray-600')
                    }
                  >
                    {isDone && <Check size={11} />}
                    {b.label}
                  </span>
                  {i < BREADCRUMBS.length - 1 && (
                    <span className="relative z-10 text-gray-700">→</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {screen === 'welcome' && (
          <div className="relative z-10 space-y-6 py-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-audora-500 shadow-knob">
              <Music size={26} className="text-white" />
            </div>
            <div className="space-y-2.5">
              <h1 className="text-3xl font-semibold leading-tight tracking-tight text-gray-100">
                Your Apple Music,
                <br />
                downloaded in lossless.
              </h1>
              <p className="max-w-sm text-sm leading-relaxed text-gray-400">
                Setup takes a few minutes and runs once. Audora will check your system,
                fetch what it needs, and sign you in.
              </p>
            </div>
            <button
              onClick={() => setScreen('system')}
              className="w-full rounded-xl bg-audora-500 px-6 py-3.5 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99]"
            >
              Get started
            </button>
            <p className="text-xs text-gray-500">
              An active Apple Music subscription is required.
            </p>
          </div>
        )}

        {screen === 'system' && (
          <div className="relative z-10 space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-xl font-semibold tracking-tight text-gray-100">
                Checking your system
              </h2>
              <p className="text-sm text-gray-400">
                Audora needs Docker Desktop running to do its work.
              </p>
            </div>
            {!check ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-black/25 p-4 text-sm text-gray-400">
                <Loader2 size={15} className="animate-spin text-audora-300" />
                Looking at your setup…
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-white/[0.07] bg-black/25 p-4">
                <Row ok={check.windows.ok} label={check.windows.label} />
                <Row
                  ok={check.docker.installed}
                  label={check.docker.installed ? 'Docker Desktop installed' : 'Docker Desktop not installed'}
                />
                <Row ok={check.docker.running} label="Docker Desktop running" />
                <Row ok={check.wsl2.ok} label="WSL2 available" />
              </div>
            )}
            {check && !check.docker.installed && (
              <a
                href={check.docker.download_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm text-audora-300 transition-colors hover:text-audora-200"
              >
                <DownloadIcon size={14} /> Get Docker Desktop
              </a>
            )}
            <div className="flex gap-2.5">
              <button
                onClick={startImages}
                disabled={!check?.docker.running}
                className="flex-1 rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
              >
                Continue
              </button>
              <button
                onClick={runCheck}
                className="rounded-xl border border-white/[0.10] bg-white/[0.05] px-4 py-3 text-sm text-gray-200 transition-colors duration-300 ease-out hover:bg-white/[0.09]"
              >
                Check again
              </button>
            </div>
          </div>
        )}

        {screen === 'images' && (
          <div className="relative z-10 space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-xl font-semibold tracking-tight text-gray-100">
                Getting the components
              </h2>
              <p className="text-sm text-gray-400">
                One-time download. The log on the right shows exactly what is happening.
              </p>
            </div>

            {/* Per-step state rows (state machine §6.1). Reflect pending /
                running / done / error. A transient error mid-silent-retry is
                still reported by the backend as `running`, so we render it as
                in-progress here — only a surfaced `error` shows as failed. */}
            <div className="space-y-3 rounded-xl border border-white/[0.07] bg-black/25 p-4">
              {IMAGE_STEPS.map(({ id, label }) => {
                const s = setupSteps[id];
                return (
                  <div key={id} className="flex items-center gap-2.5 text-sm">
                    {s?.status === 'done' ? (
                      <Check size={15} className="shrink-0 text-emerald-400" />
                    ) : s?.status === 'error' ? (
                      <X size={15} className="shrink-0 text-rose-400" />
                    ) : s?.status === 'running' ? (
                      <Loader2 size={15} className="shrink-0 animate-spin text-audora-300" />
                    ) : (
                      /* Queued: a static ring, not a spinner — nothing is
                         happening on this step yet. */
                      <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-gray-600" />
                    )}
                    <span>{label}</span>
                    <span className="ml-auto shrink-0 text-xs text-gray-500">
                      {s?.message || 'waiting'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Live progress (Workstream D panel), fed REAL aggregate bytes.
                The panel owns speed/ETA + the collapsed "Show details" log
                (§8.1). Rendered whenever a pull is active or has run. */}
            {!failedStep && (activeStep || downloaderStep) && !bothDone && (
              <LiveProgressPanel layers={panelLayers} narration={panelNarration} />
            )}

            {/* Failure UI: EXACTLY ONE primary recovery button (RetryButton),
                with the diagnostics copy as the ONLY secondary action beside
                it (§1.1, §7, §8.2). Never a dead end, never a terminal. */}
            {failedStep && (
              <div className="space-y-4 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] p-4">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-rose-100">
                      {failureHeadline(failedStep)}
                    </p>
                    {failedStep.message && (
                      /* Secondary text tinted from the surface hue — gray on a
                         rose panel reads as a defect. */
                      <p className="text-xs text-rose-200/70">{failedStep.message}</p>
                    )}
                  </div>
                </div>

                {/* One primary recovery action. Its label + click behavior are
                    chosen from the error code inside RetryButton. */}
                <RetryButton error={failedStep.error} />

                {/* Secondary (permitted) — copy diagnostics, not a competing
                    recovery path. */}
                <div>
                  <DiagnosticReportButton failedStep={failedStepId} />
                </div>
              </div>
            )}

            <button
              onClick={startWrapperForSetup}
              disabled={!bothDone}
              className="w-full rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
            >
              Continue
            </button>
          </div>
        )}

        {screen === 'signin' && (
          <div className="relative z-10 space-y-4">
            <h2 className="text-xl font-semibold tracking-tight text-gray-100">
              {busy && !need2fa ? 'Starting Apple Music' : 'Sign in to Apple Music'}
            </h2>
            {authErr && <p className="text-sm text-rose-300">{authErr}</p>}
            {busy && !email && !password && !need2fa ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-black/25 p-4 text-sm text-gray-400">
                <Loader2 size={15} className="animate-spin text-audora-300" />
                {authMsg || 'Waiting for the wrapper...'}
              </div>
            ) : !need2fa ? (
              <>
                {authMsg && <p className="text-sm text-gray-400">{authMsg}</p>}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Apple ID (email)"
                  aria-label="Apple ID email"
                  autoComplete="username"
                  className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-audora-500/60 focus:outline-none"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  aria-label="Apple ID password"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-audora-500/60 focus:outline-none"
                />
                <button
                  onClick={submitCreds}
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
                >
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {busy ? authMsg || 'Signing in...' : 'Sign In'}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-400">{authMsg}</p>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, ''));
                    // Clear a stale "cannot be empty" as soon as they type.
                    if (authErr) setAuthErr('');
                  }}
                  placeholder="6-digit code"
                  aria-label="Two-factor verification code"
                  aria-invalid={Boolean(authErr)}
                  autoComplete="one-time-code"
                  className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-center text-lg tracking-[0.5em] text-gray-100 placeholder:text-gray-500 placeholder:tracking-normal focus:border-audora-500/60 focus:outline-none"
                />
                <button
                  onClick={submit2fa}
                  disabled={busy || code.trim().length < 6}
                  className="w-full rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
                >
                  {busy && <Loader2 size={16} className="mr-2 inline animate-spin" />}
                  {busy ? 'Verifying...' : 'Verify'}
                </button>
              </>
            )}
          </div>
        )}

        {screen === 'done' && (
          <div className="relative z-10 space-y-6 py-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15">
              <Check size={26} className="text-emerald-300" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-100">
              Everything is ready
            </h2>
            <p className="text-sm leading-relaxed text-gray-400">
              You can now download Apple Music tracks in lossless quality.
            </p>
            <button
              onClick={finish}
              className="w-full rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99]"
            >
              Open Audora
            </button>
          </div>
        )}
        </div>

        {/* Live log, right-hand column. Hidden on the welcome splash (nothing
            has happened yet) and on narrow windows, where the wizard takes
            priority over the log. */}
        {screen !== 'welcome' && (
          <SetupTerminalPanel
            lines={terminalLines}
            title={showingWrapperLogs ? 'audora-wrapper log' : 'Setup log'}
            className="hidden max-h-[70vh] min-w-0 flex-1 lg:flex"
          />
        )}
      </div>
    </div>
  );
}
