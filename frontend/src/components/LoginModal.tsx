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
      <div className="w-full max-w-md bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl p-6 relative">
        <button
          onClick={closeLogin}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-300"
        >
          <X size={18} />
        </button>

        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center mb-3">
            <Music size={26} className="text-white" />
          </div>
          <h2 className="text-xl font-bold">Sign in to Apple Music</h2>
          <p className="text-sm text-gray-500 mt-1">
            Your password is sent only to the local decryption service.
          </p>
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-400 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {(stage === 'credentials' || stage === 'awaiting') && (
          <div className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Apple ID (email)"
              disabled={stage === 'awaiting'}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-violet-500 disabled:opacity-50"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              disabled={stage === 'awaiting'}
              onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-violet-500 disabled:opacity-50"
            />
            <button
              onClick={submitCredentials}
              disabled={busy}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-3 text-sm font-medium flex items-center justify-center gap-2"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {stage === 'awaiting' ? status || 'Signing in...' : 'Sign In'}
            </button>
          </div>
        )}

        {stage === '2fa' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-400 text-center">{status}</p>
            <input
              id="twofa-input"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && submit2fa()}
              placeholder="6-digit code"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-center text-lg tracking-[0.5em] focus:outline-none focus:border-violet-500"
            />
            <button
              onClick={submit2fa}
              disabled={busy}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-3 text-sm font-medium flex items-center justify-center gap-2"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              Verify
            </button>
          </div>
        )}

        {stage === 'success' && (
          <div className="text-center py-4">
            <p className="text-green-400 text-lg font-medium">✔ {status}</p>
          </div>
        )}
      </div>
    </div>
  );
}
