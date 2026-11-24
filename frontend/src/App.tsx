import { useEffect, useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import TopNav from './components/TopNav';
import StatusBar from './components/StatusBar';
import MiniPlayer from './components/MiniPlayer';
import LoginModal from './components/LoginModal';
import SetupWizard from './components/SetupWizard';
import Home from './pages/Home';
import Download from './pages/Download';
import Queue from './pages/Queue';
import Library from './pages/Library';
import History from './pages/History';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import AudioEffects from './pages/AudioEffects';
import About from './pages/About';
import { useAppStore } from './store/useAppStore';
import { useWebSocket } from './hooks/useWebSocket';
import { electronAPI } from './api/client';

function App() {
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const checkSetup = useAppStore((s) => s.checkSetup);
  const markSetupComplete = useAppStore((s) => s.markSetupComplete);
  const markLibraryOnly = useAppStore((s) => s.markLibraryOnly);
  const loginOpen = useAppStore((s) => s.loginModalOpen);
  const setupComplete = useAppStore((s) => s.setupComplete);
  const libraryOnly = useAppStore((s) => s.libraryOnly);
  const [startingDownloads, setStartingDownloads] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    checkSetup();
  }, [checkSetup]);

  useEffect(() => {
    if (!setupComplete) return;
    refreshStatus();
    const id = setInterval(refreshStatus, 5000);
    return () => clearInterval(id);
  }, [refreshStatus, setupComplete]);

  useEffect(() => {
    if (!electronAPI.adjustZoom) return;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      accumulated += pixels;
      const count = Math.min(3, Math.floor(Math.abs(accumulated) / 40));
      if (!count) return;
      const steps = -Math.sign(accumulated) * count;
      accumulated += steps * 40;
      void electronAPI.adjustZoom?.(steps);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // Fire a Windows notification whenever a download finishes.
  useWebSocket('/ws/progress', {
    enabled: setupComplete === true,
    onMessage: (data) => {
      if (data?.status === 'completed' || data?.status === 'failed' || data?.status === 'convert_failed') {
        const partial = (data.converted || 0) > 0 && ((data.failed || 0) > 0 || data.status === 'convert_failed');
        const ok = data.status === 'completed' && !data.failed;
        electronAPI.showNotification?.({
          title: ok ? 'Download complete' : partial ? 'Some tracks are ready' : 'Download incomplete',
          body: ok
            ? `${data.converted || 0} track(s) converted to FLAC.`
            : data.status === 'convert_failed'
            ? `${data.converted || 0} converted; ${data.convert_failed_tracks?.length || 0} could not be converted. See the download log.`
            : `${data.converted || 0} FLAC ready; ${data.failed || 0} track(s) still need downloading.`,
        });
      }
    },
  });

  if (setupComplete === null) {
    return <div className="grid h-screen place-items-center bg-surface-void text-sm text-gray-400" role="status">Opening Audora…</div>;
  }

  if (!setupComplete && (!libraryOnly || startingDownloads)) {
    return <SetupWizard
      onComplete={() => {
        markSetupComplete();
        setStartingDownloads(false);
      }}
      onLocalLibrary={() => {
        markLibraryOnly();
        navigate('/library', { replace: true });
      }}
      onReturnToLibrary={libraryOnly ? () => {
        setStartingDownloads(false);
        navigate('/library');
      } : undefined}
    />;
  }

  const downloadSetup = (
    <section className="glass relative mt-2 max-w-lg rounded-2xl p-6">
      <div className="relative z-10 space-y-4">
        <h1 className="text-xl font-semibold text-gray-100">Apple Music downloads</h1>
        <p className="text-sm text-gray-400">Set up Docker and sign in to Apple Music to download tracks. You can keep listening to your local library any time.</p>
        <button type="button" onClick={() => setStartingDownloads(true)}
          className="rounded-xl bg-audora-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-audora-400">
          Set up downloads
        </button>
      </div>
    </section>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-void text-gray-100">
      <TopNav />
      <main className="scrollbar-thin flex-1 overflow-y-auto px-8 pb-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/download" element={libraryOnly ? downloadSetup : <Download />} />
          <Route path="/queue" element={libraryOnly ? downloadSetup : <Queue />} />
          <Route path="/audio-effects" element={<AudioEffects />} />
          <Route path="/library" element={<Library />} />
          <Route path="/history" element={<History />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
      <MiniPlayer />
      <StatusBar />
      {!libraryOnly && loginOpen && <LoginModal />}
    </div>
  );
}

export default App;
