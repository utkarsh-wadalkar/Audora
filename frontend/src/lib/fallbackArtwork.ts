import cherryVinyl from '../assets/track-artwork/cherry-vinyl.png';
import cobaltPressing from '../assets/track-artwork/cobalt-pressing.png';
import windowLight from '../assets/track-artwork/window-light.png';
import winterMorning from '../assets/track-artwork/winter-morning.png';
import rainClearing from '../assets/track-artwork/rain-clearing.png';
import lastLight from '../assets/track-artwork/last-light.png';
import highNoon from '../assets/track-artwork/high-noon.png';

const fallbackCovers = [
  cherryVinyl,
  cobaltPressing,
  windowLight,
  winterMorning,
  rainClearing,
  lastLight,
  highNoon,
];

export function fallbackCover(filePath: string) {
  let hash = 2166136261;
  for (let i = 0; i < filePath.length; i++) {
    hash = Math.imul(hash ^ filePath.charCodeAt(i), 16777619);
  }
  return fallbackCovers[(hash >>> 0) % fallbackCovers.length];
}
