import { useState, useEffect } from 'react';
import { X, Loader2, Music } from 'lucide-react';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAppStore } from '../store/useAppStore';

type Stage = 'credentials' | 'awaiting' | '2fa' | 'success';

export default function LoginModal() {
  const closeLogin = useAppStore((s) => s.closeLogin);
  const refreshStatus = useAppStore((s) => s.refreshStatus);

  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Listen to live auth events from the backend.
  useWebSocket('/ws/auth', {
    onMessage: (data) => {
      if (!data || typeof data !== 'object') return;
      switch (data.type) {
        case 'auth_progress':
          setStatus(data.message);
          break;
        case 'auth_2fa_required':
          setStage('2fa');
          setStatus(data.message);
          setError('');
          setBusy(false);
          break;
        case 'auth_success':
          setStage('success');
          setStatus(data.message);
          setBusy(false);
          refreshStatus();
          setTimeout(() => closeLogin(), 1200);
          break;
        case 'auth_error':
          setError(data.message || 'Sign in failed');
          setStage('credentials');
          setBusy(false);
          break;
      }
    },
  });

  useEffect(() => {
    if (stage === '2fa') {
      const el = document.getElementById('twofa-input');
      el?.focus();
    }
  }, [stage]);

  const submitCredentials = async () => {
    if (!email.trim() || !password) {
      setError('Enter your Apple ID and password.');
      return;
    }
    setError('');
    setBusy(true);
    setStage('awaiting');
    setStatus('Connecting to Apple Music...');
    try {
      const res = await api.post('/auth/login', { email, password });
      if (!res.data.success) {
        setError(res.data.error || 'Failed to start login');
        setStage('credentials');
        setBusy(false);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setStage('credentials');
      setBusy(false);
    }
  };

  const submit2fa = async () => {
    if (code.trim().length < 4) {
      setError('Enter the code sent to your device.');
      return;
    }
    setError('');
    setBusy(true);
    setStatus('Verifying code...');
    try {
      await api.post('/auth/2fa', { code: code.trim() });
    } catch (e: any) {
      setError(e?.message || 'Failed to submit code');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="glass relative w-full max-w-md rounded-3xl p-6">
        <button
          onClick={closeLogin}
          aria-label="Close sign-in"
          className="absolute right-4 top-4 z-10 text-gray-500 transition-colors hover:text-gray-300"
        >
          <X size={18} />
        </button>

        <div className="relative z-10 mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#4A8FD6] to-[#A78BC9]">
            <Music size={26} className="text-white" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-gray-100">
            Sign in to Apple Music
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Your password is sent only to the local decryption service.
          </p>
        </div>

        {error && (
          <div className="relative z-10 mb-4 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}

        {(stage === 'credentials' || stage === 'awaiting') && (
          <div className="relative z-10 space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Apple ID (email)"
              aria-label="Apple ID email"
              autoComplete="username"
              disabled={stage === 'awaiting'}
              className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-audora-500/60 focus:outline-none disabled:opacity-50"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Apple ID password"
              autoComplete="current-password"
              disabled={stage === 'awaiting'}
              onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
              className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-audora-500/60 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={submitCredentials}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {stage === 'awaiting' ? status || 'Signing in...' : 'Sign In'}
            </button>
          </div>
        )}

        {stage === '2fa' && (
          <div className="relative z-10 space-y-3">
            <p className="text-center text-sm text-gray-400">{status}</p>
            <input
              id="twofa-input"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && submit2fa()}
              placeholder="6-digit code"
              aria-label="Two-factor verification code"
              autoComplete="one-time-code"
              className="w-full rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-center text-lg tracking-[0.5em] text-gray-100 placeholder:tracking-normal placeholder:text-gray-500 focus:border-audora-500/60 focus:outline-none"
            />
            <button
              onClick={submit2fa}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-audora-500 px-4 py-3 text-sm font-medium text-white shadow-knob transition-[background-color,transform] duration-300 ease-out hover:bg-audora-400 active:scale-[0.99] disabled:bg-white/[0.06] disabled:text-gray-500 disabled:shadow-none"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              Verify
            </button>
          </div>
        )}

        {stage === 'success' && (
          <div className="relative z-10 py-4 text-center">
            <p className="text-lg font-medium text-emerald-300">✔ {status}</p>
          </div>
        )}
      </div>
    </div>
  );
}
