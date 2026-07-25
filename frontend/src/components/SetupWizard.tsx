import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Loader2, Music, Download as DownloadIcon, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore, type SetupProgressEvent, type SetupStepState } from '../store/useAppStore';
import LiveProgressPanel, { type PullEvent } from './LiveProgressPanel';
import RetryButton from './RetryButton';
import DiagnosticReportButton from './DiagnosticReportButton';

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

  // Subscribe to the live event stream and funnel every event into the store.
  // On (re)connect (readyState → 'open') we re-seed from REST so no state is
  // lost across a drop — the seed only fills gaps and never downgrades a live
  // step.
  const { readyState } = useWebSocket('/ws/setup', {
    onMessage: (data) => {
      if (data?.type === 'setup_progress') {
        applySetupEvent(data as SetupProgressEvent);
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

  const submit2fa = async () => {
    setBusy(true);
    await api.post('/auth/2fa', { code: code.trim() });
  };

  const finish = async () => {
    await api.post('/setup/complete');
    onComplete();
  };

  const Row = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <Check size={16} className="text-green-400" />
      ) : (
        <X size={16} className="text-red-400" />
      )}
      <span className={ok ? 'text-gray-200' : 'text-gray-400'}>{label}</span>
    </div>
  );

  // --- Derived image-step view -------------------------------------------
  const downloaderStep = setupSteps['pull_downloader'];
  const wrapperStep = setupSteps['build_wrapper'];
  const bothDone =
    downloaderStep?.status === 'done' && wrapperStep?.status === 'done';

  // The single step (if any) currently in a surfaced failure state. Only the
  // active/first failed step drives the failure UI — exactly one recovery path.
  const failedStepId = IMAGE_STEPS.find(
    (s) => setupSteps[s.id]?.status === 'error',
  )?.id;
  const failedStep = failedStepId ? setupSteps[failedStepId] : undefined;

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
    <div className="fixed inset-0 z-50 bg-gray-950 flex items-center justify-center p-8">
      <div className="w-full max-w-lg bg-gray-900 rounded-2xl border border-gray-800 p-8 shadow-2xl">
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
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 ' +
                      (isCurrent
                        ? 'bg-violet-600/30 text-violet-200 font-medium'
                        : isDone
                        ? 'text-green-400'
                        : 'text-gray-600')
                    }
                  >
                    {isDone && <Check size={11} />}
                    {b.label}
                  </span>
                  {i < BREADCRUMBS.length - 1 && (
                    <span className="text-gray-700">→</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {screen === 'welcome' && (
          <div className="text-center space-y-5">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <Music size={30} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold">Welcome to Audora</h1>
            <p className="text-gray-400 text-sm">Let's get you set up in a few quick steps.</p>
            <button
              onClick={() => setScreen('system')}
              className="bg-violet-600 hover:bg-violet-500 px-6 py-3 rounded-lg font-medium"
            >
              Get Started
            </button>
          </div>
        )}

        {screen === 'system' && (
          <div className="space-y-5">
            <h2 className="text-xl font-bold">System Check</h2>
            {!check ? (
              <Loader2 className="animate-spin text-violet-400" />
            ) : (
              <div className="space-y-3 bg-gray-950 rounded-lg p-4 border border-gray-800">
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
                className="inline-flex items-center gap-2 text-violet-400 text-sm"
              >
                <DownloadIcon size={14} /> Download Docker Desktop
              </a>
            )}
            <div className="flex gap-3">
              <button onClick={runCheck} className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm">
                Re-check
              </button>
              <button
                onClick={startImages}
                disabled={!check?.docker.running}
                className="bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2 rounded-lg text-sm"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {screen === 'images' && (
          <div className="space-y-5">
            <h2 className="text-xl font-bold">Setting up components</h2>

            {/* Per-step state rows (state machine §6.1). Reflect pending /
                running / done / error. A transient error mid-silent-retry is
                still reported by the backend as `running`, so we render it as
                in-progress here — only a surfaced `error` shows as failed. */}
            <div className="space-y-3 bg-gray-950 rounded-lg p-4 border border-gray-800">
              {IMAGE_STEPS.map(({ id, label }) => {
                const s = setupSteps[id];
                return (
                  <div key={id} className="flex items-center gap-2 text-sm">
                    {s?.status === 'done' ? (
                      <Check size={16} className="text-green-400" />
                    ) : s?.status === 'error' ? (
                      <X size={16} className="text-red-400" />
                    ) : s?.status === 'running' ? (
                      <Loader2 size={16} className="animate-spin text-violet-400" />
                    ) : (
                      <Loader2 size={16} className="animate-spin text-gray-600" />
                    )}
                    <span>{label}</span>
                    <span className="text-gray-600 text-xs ml-auto">
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
              <div className="space-y-4 bg-red-950/30 border border-red-900/50 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-red-200">
                      {failureHeadline(failedStep)}
                    </p>
                    {failedStep.message && (
                      <p className="text-xs text-gray-400">{failedStep.message}</p>
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
              onClick={() => setScreen('signin')}
              disabled={!bothDone}
              className="bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2 rounded-lg text-sm"
            >
              Continue
            </button>
          </div>
        )}

        {screen === 'signin' && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold">Sign in to Apple Music</h2>
            {authErr && <p className="text-sm text-red-400">{authErr}</p>}
            {!need2fa ? (
              <>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Apple ID (email)"
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-violet-500"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-violet-500"
                />
                <button
                  onClick={submitCreds}
                  disabled={busy}
                  className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-3 text-sm font-medium flex items-center justify-center gap-2"
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
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit code"
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-center text-lg tracking-[0.5em] focus:outline-none focus:border-violet-500"
                />
                <button
                  onClick={submit2fa}
                  disabled={busy}
                  className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-3 text-sm font-medium"
                >
                  Verify
                </button>
              </>
            )}
          </div>
        )}

        {screen === 'done' && (
          <div className="text-center space-y-5">
            <div className="w-16 h-16 mx-auto rounded-full bg-green-500/20 flex items-center justify-center">
              <Check size={30} className="text-green-400" />
            </div>
            <h2 className="text-xl font-bold">Everything is ready</h2>
            <p className="text-gray-400 text-sm">
              You can now download Apple Music tracks in lossless quality.
            </p>
            <button
              onClick={finish}
              className="bg-violet-600 hover:bg-violet-500 px-6 py-3 rounded-lg font-medium"
            >
              Open App
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
