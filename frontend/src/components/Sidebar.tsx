import { NavLink } from 'react-router-dom';
import {
  Home,
  Download,
  ListMusic,
  Library,
  History,
  FileText,
  Settings,
  Info,
} from 'lucide-react';

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/download', icon: Download, label: 'Download' },
  { to: '/queue', icon: ListMusic, label: 'Queue' },
  { to: '/library', icon: Library, label: 'Library' },
  { to: '/history', icon: History, label: 'History' },
  { to: '/logs', icon: FileText, label: 'Logs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/about', icon: Info, label: 'About' },
];

export default function Sidebar() {
  return (
    <aside className="w-60 bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-6">
        <h1 className="wordmark text-[2rem] leading-[1.15]">
          Audora
        </h1>
        <p className="text-xs text-gray-500 mt-1">Music Downloader</p>
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-violet-600/20 text-violet-300'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`
            }
          >
            <item.icon size={18} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
