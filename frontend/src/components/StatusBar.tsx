import { Circle, Container, Library, Server, User } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import UpdateIndicator from './UpdateIndicator';

// NOTE: lucide-react has no "Docker" icon; "Container" is the closest fit.
export default function StatusBar() {
  const dockerStatus = useAppStore((s) => s.dockerStatus);
  const wrapperStatus = useAppStore((s) => s.wrapperStatus);
  const authStatus = useAppStore((s) => s.authStatus);
  const openLogin = useAppStore((s) => s.openLogin);
  const libraryOnly = useAppStore((s) => s.libraryOnly);

  const StatusDot = ({ ok }: { ok: boolean }) => (
    <Circle
      size={7}
      className={ok ? 'fill-emerald-400 text-emerald-400' : 'fill-rose-400 text-rose-400'}
    />
  );

  return (
    <div className="flex h-7 shrink-0 items-center gap-6 px-8 pb-1 text-[11px] text-gray-500">
      <UpdateIndicator />
      {libraryOnly ? (
        <div className="flex items-center gap-2"><Library size={12} /> Local library</div>
      ) : <>
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
        className="flex items-center gap-2 rounded transition-colors hover:text-gray-300"
        onClick={() => !authStatus && openLogin()}
      >
        <User size={12} />
        <StatusDot ok={authStatus} />
        <span>{authStatus ? 'Signed in' : 'Sign in'}</span>
      </button>
      </>}
    </div>
  );
}
