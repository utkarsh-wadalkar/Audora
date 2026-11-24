import { useState } from 'react';
import { Music } from 'lucide-react';
import { API_BASE } from '../api/client';
import cherryVinyl from '../assets/track-artwork/cherry-vinyl.png';
import cobaltPressing from '../assets/track-artwork/cobalt-pressing.png';
import windowLight from '../assets/track-artwork/window-light.png';
import winterMorning from '../assets/track-artwork/winter-morning.png';
import rainClearing from '../assets/track-artwork/rain-clearing.png';
import lastLight from '../assets/track-artwork/last-light.png';
import highNoon from '../assets/track-artwork/high-noon.png';
import type { Track } from '../store/useAppStore';

const fallbackCovers = [
  cherryVinyl,
  cobaltPressing,
  windowLight,
  winterMorning,
  rainClearing,
  lastLight,
  highNoon,
];

function fallbackCover(filePath: string) {
  let hash = 2166136261;
  for (let i = 0; i < filePath.length; i++) {
    hash = Math.imul(hash ^ filePath.charCodeAt(i), 16777619);
  }
  return fallbackCovers[(hash >>> 0) % fallbackCovers.length];
}

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
