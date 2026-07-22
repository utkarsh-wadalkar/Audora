import { ExternalLink } from 'lucide-react';

export default function About() {
  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold">About Audora</h2>
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-violet-300">Audora v1.2</h3>
          <p className="text-gray-400 text-sm mt-1">Desktop Music Downloader & Library Manager</p>
        </div>
        <div className="space-y-2 text-sm text-gray-400">
          <p>Audora wraps the Apple Music ALAC downloader ecosystem behind a polished native Windows desktop app.</p>
          <p>No terminal. No Docker commands. Just paste a URL and download.</p>
        </div>
        <div className="pt-4 border-t border-gray-800 space-y-2">
          <a
            href="https://github.com/zhaarey/apple-music-downloader"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-violet-400 hover:text-violet-300"
          >
            <ExternalLink size={14} /> apple-music-downloader
          </a>
          <a
            href="https://github.com/WorldObservationLog/wrapper"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-violet-400 hover:text-violet-300"
          >
            <ExternalLink size={14} /> wrapper (WorldObservationLog fork)
          </a>
        </div>
        <div className="text-xs text-gray-600 pt-2">
          Built with Electron, React, Tailwind, FastAPI, and Docker.
        </div>
      </div>
    </div>
  );
}
