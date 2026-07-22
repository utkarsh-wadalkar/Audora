import { useEffect, useState } from 'react';
import { Check, X, Loader2, Music, Download as DownloadIcon } from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';

interface SystemCheck {
  windows: { ok: boolean; label: string };
  docker: { installed: boolean; running: boolean; download_url: string };
  wsl2: { ok: boolean };
  images: { downloader: boolean; wrapper: boolean };
}

type Screen = 'welcome' | 'system' | 'images' | 'signin' | 'done';

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [check, setCheck] = useState<SystemCheck | null>(null);
  const [imageSteps, setImageSteps] = useState<Record<string, { status: string; message: string }>>({});

  // Sign-in state (mirrors LoginModal, inlined here).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [authMsg, setAuthMsg] = useState('');
  const [authErr, setAuthErr] = useState('');
  const [busy, setBusy] = useState(false);

  useWebSocket('/ws/setup', {
    onMessage: (data) => {
      if (data?.type === 'setup_progress') {
        setImageSteps((prev) => ({
          ...prev,
          [data.step]: { status: data.status, message: data.message },
        }));
      }
    },
  });

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

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex items-center justify-center p-8">
      <div className="w-full max-w-lg bg-gray-900 rounded-2xl border border-gray-800 p-8 shadow-2xl">
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
            <div className="space-y-3 bg-gray-950 rounded-lg p-4 border border-gray-800">
              {['pull_downloader', 'build_wrapper'].map((step) => {
                const s = imageSteps[step];
                const label =
                  step === 'pull_downloader' ? 'apple-music-downloader' : 'wrapper image';
                return (
                  <div key={step} className="flex items-center gap-2 text-sm">
                    {s?.status === 'done' ? (
                      <Check size={16} className="text-green-400" />
                    ) : s?.status === 'error' ? (
                      <X size={16} className="text-red-400" />
                    ) : (
                      <Loader2 size={16} className="animate-spin text-violet-400" />
                    )}
                    <span>{label}</span>
                    <span className="text-gray-600 text-xs ml-auto">{s?.message || 'waiting'}</span>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setScreen('signin')}
              disabled={imageSteps['build_wrapper']?.status !== 'done'}
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
