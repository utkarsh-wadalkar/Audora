import { useState } from 'react';
import { Music } from 'lucide-react';
import { API_BASE } from '../api/client';
import { fallbackCover } from '../lib/fallbackArtwork';
import type { Track } from '../store/useAppStore';

export default function TrackArtwork({ track, size = 28, eager = false }: {
  track?: Track | null;
  size?: number;
  eager?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const embeddedSrc = track?.id && track.artwork_revision
    ? `${API_BASE}/library/art/${track.id}?v=${encodeURIComponent(track.artwork_revision)}`
    : undefined;

  if (!track) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-gray-600" aria-hidden="true">
        <Music size={size} />
      </div>
    );
  }

  const src = embeddedSrc && embeddedSrc !== failedSrc ? embeddedSrc : fallbackCover(track.file_path);
  return (
    <img
      key={src}
      src={src}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      className="h-full w-full object-cover"
      onError={src === embeddedSrc ? () => setFailedSrc(src) : undefined}
    />
  );
}
