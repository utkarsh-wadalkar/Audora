import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
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
import About from './pages/About';
import { useAppStore } from './store/useAppStore';
import { useWebSocket } from './hooks/useWebSocket';
import { electronAPI } from './api/client';

function App() {
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const checkSetup = useAppStore((s) => s.checkSetup);
  const markSetupComplete = useAppStore((s) => s.markSetupComplete);
  const loginOpen = useAppStore((s) => s.loginModalOpen);
  const setupComplete = useAppStore((s) => s.setupComplete);

  useEffect(() => {
    checkSetup();
    refreshStatus();
    const id = setInterval(refreshStatus, 5000);
    return () => clearInterval(id);
  }, [refreshStatus, checkSetup]);

  // Fire a Windows notification whenever a download finishes.
  useWebSocket('/ws/progress', {
    onMessage: (data) => {
      if (data?.status === 'completed' || data?.status === 'failed') {
        const ok = data.status === 'completed';
        electronAPI.showNotification?.({
          title: ok ? 'Download complete' : 'Download failed',
          body: ok
            ? `${data.completed || 0} track(s) downloaded${data.failed ? `, ${data.failed} failed` : ''}.`
            : `${data.failed || 0} track(s) failed. See Logs for details.`,
        });
      }
    },
  });

  // Show the first-run wizard until setup is complete.
  if (setupComplete === false) {
    return <SetupWizard onComplete={markSetupComplete} />;
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/download" element={<Download />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/library" element={<Library />} />
            <Route path="/history" element={<History />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
        <MiniPlayer />
        <StatusBar />
      </div>
      {loginOpen && <LoginModal />}
    </div>
  );
}

export default App;
