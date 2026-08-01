import { NavLink } from 'react-router-dom';
import {
  Disc3,
  DownloadCloud,
  Library,
  ListMusic,
  History,
  FileText,
  Settings,
  Info,
} from 'lucide-react';

/**
 * Primary destinations live in the centre pill rail. Utility destinations sit
 * in the right-hand icon cluster so the rail stays legible at eight routes.
 */
const primaryRoutes = [
  { to: '/', icon: Disc3, label: 'Listen' },
  { to: '/download', icon: DownloadCloud, label: 'Download' },
  { to: '/library', icon: Library, label: 'Library' },
  { to: '/queue', icon: ListMusic, label: 'Queue' },
];

const utilityRoutes = [
  { to: '/history', icon: History, label: 'History' },
  { to: '/logs', icon: FileText, label: 'Logs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/about', icon: Info, label: 'About' },
];

export default function TopNav() {
  return (
    <header className="drag-region flex shrink-0 items-center gap-4 px-6 pb-2 pt-4">
      <NavLink to="/" className="no-drag group flex items-baseline gap-2">
        <span className="wordmark text-[1.75rem] leading-[1.15]">
          Audora
        </span>
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-gray-500">
          Lossless
        </span>
      </NavLink>

      <nav className="no-drag glass mx-auto flex items-center gap-1 rounded-full p-1">
        {primaryRoutes.map((route) => (
          <NavLink
            key={route.to}
            to={route.to}
            end={route.to === '/'}
            className={({ isActive }) =>
              `relative z-10 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-300 ease-out ${
                isActive
                  ? 'bg-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                  : 'text-gray-400 hover:text-gray-100'
              }`
            }
          >
            <route.icon size={16} strokeWidth={2} />
            {route.label}
          </NavLink>
        ))}
      </nav>

      <div className="no-drag flex items-center gap-1">
        {utilityRoutes.map((route) => (
          <NavLink
            key={route.to}
            to={route.to}
            title={route.label}
            aria-label={route.label}
            className={({ isActive }) =>
              `flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-300 ease-out ${
                isActive
                  ? 'bg-white/[0.10] text-audora-300'
                  : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-200'
              }`
            }
          >
            <route.icon size={16} strokeWidth={2} />
          </NavLink>
        ))}
      </div>
    </header>
  );
}
