import { Circle, Container, Server, User } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

// NOTE: lucide-react has no "Docker" icon; "Container" is the closest fit.
export default function StatusBar() {
  const dockerStatus = useAppStore((s) => s.dockerStatus);
  const wrapperStatus = useAppStore((s) => s.wrapperStatus);
  const authStatus = useAppStore((s) => s.authStatus);
  const openLogin = useAppStore((s) => s.openLogin);

  const StatusDot = ({ ok }: { ok: boolean }) => (
    <Circle
      size={8}
      className={ok ? 'text-green-400 fill-green-400' : 'text-red-400 fill-red-400'}
    />
  );

  return (
    <div className="h-8 bg-gray-900 border-t border-gray-800 flex items-center px-4 gap-6 text-xs text-gray-400">
      <div className="flex items-center gap-2">
        <Container size={12} />
        <StatusDot ok={dockerStatus} />
        <span>Docker</span>
      </div>
      <div className="flex items-center gap-2">
        <Server size={12} />
        <StatusDot ok={wrapperStatus} />
        <span>Wrapper</span>
      </div>
      <button
        className="flex items-center gap-2 hover:text-gray-200"
        onClick={() => !authStatus && openLogin()}
      >
        <User size={12} />
        <StatusDot ok={authStatus} />
        <span>{authStatus ? 'Signed In' : 'Not Signed In'}</span>
      </button>
    </div>
  );
}
