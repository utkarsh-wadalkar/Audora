import { ExternalLink } from 'lucide-react';

const CREDITS = [
  {
    href: 'https://github.com/zhaarey/apple-music-downloader',
    label: 'zhaarey / apple-music-downloader',
    role: 'The downloader Audora drives',
  },
  {
    href: 'https://github.com/WorldObservationLog/wrapper',
    label: 'WorldObservationLog / wrapper',
    role: 'The Apple Music wrapper',
  },
];

export default function About() {
  return (
    <div className="max-w-2xl animate-rise-in space-y-6 pt-2">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-100">About</h1>

      <div className="glass space-y-4 rounded-2xl p-6">
        <div className="relative z-10">
          <p className="flex items-baseline gap-2 text-lg font-semibold text-gray-100">
            <span className="wordmark text-[1.6rem] leading-[1.15]">Audora</span>
            <span>1.4.0</span>
          </p>
          <p className="mt-1 text-sm text-gray-400">
            Lossless downloader and library manager for Apple Music.
          </p>
        </div>

        <div className="relative z-10 space-y-2 text-sm leading-relaxed text-gray-400">
          <p>
            Audora downloads albums, playlists and tracks in ALAC and keeps them playable
            offline, with a built-in player and library browser. Docker and the command
            line stay out of your way, but the log panel keeps them visible when you need
            to know what happened.
          </p>
          <p className="text-gray-500">
            An active Apple Music subscription is required. Audora is for personal offline
            listening to music you already pay for.
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
          Built on
        </h2>
        <div className="glass overflow-hidden rounded-2xl">
          {CREDITS.map((credit, index) => (
            <a
              key={credit.href}
              href={credit.href}
              target="_blank"
              rel="noreferrer"
              className={`relative z-10 flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.05] ${
                index > 0 ? 'border-t border-white/[0.05]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-gray-100">{credit.label}</p>
                <p className="text-xs text-gray-500">{credit.role}</p>
              </div>
              <ExternalLink size={14} className="shrink-0 text-gray-500" />
            </a>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          Audora exists because of this upstream work. Thank you to both projects.
        </p>
      </section>

      <p className="text-xs text-gray-600">
        Electron, React, Tailwind, FastAPI and Docker. Windows 10 and 11 only for now.
      </p>
    </div>
  );
}
