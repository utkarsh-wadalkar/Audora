# Verification — 2026-09-03

The marketing site and Some Songs I Like showcase are implemented and locally
verified. Deployment uses the repository-backed Vercel project described below.

## Completed checks

- Production static build: passed (`npm run build`).
- Type generation and TypeScript: passed (`npm run typecheck`).
- ESLint: passed with zero warnings (`npm run lint`).
- Playwright: all 13 scenarios passed. The two song-control scenarios also passed
  after the final accessible-name and audio-pause adjustments.
- Mobile Lighthouse: accessibility 100, best practices 100, SEO 100, with no
  failed audits. These are local audit results, not field performance metrics.
- Dependency audit after updating the image preparation tool: zero vulnerabilities.
- Desktop/mobile visual inspection: completed. Layouts checked at 320, 390, 768,
  1024 and 1440 CSS pixels; no horizontal document overflow.

## Music behavior and assets

- All 12 songs appear individually, without album/artist/folder grouping.
- Card selection, selected title/artist/cover, record label and audio source stay
  synchronized. Previous/Next retains playback when switching from a playing song.
- Start/Pause operates actual FLAC and MP3 audio through one HTML audio element.
- Rapid direct selection replaces the active source; the prior stream is stopped.
- No full audio requests occur before playback. Audio uses `preload="none"`.
- The 3D scene loads near the viewport and draws on demand. Progress updates do
  not redraw it; off-screen rendering stops while audio may continue.
- Reduced motion keeps playback available with a still record. WebGL context loss
  restores the poster and leaves music playback working.
- All 12 audio URLs and 12 cover URLs resolve from the static build. Audio range
  requests return HTTP 206. All 24 built files match their public source copies.
- SHA-256 comparison confirms all eight FLAC copies exactly match their originals.
- Client/app/catalog code contains no source-folder path, `file://` URL, or local
  filesystem API. The optional preparation script is not invoked by the build.

## Deployment handoff

- Vercel project: `audora-music`
- Team: `utkarshs-projects-d8755b84`
- Repository: `utkarsh-wadalkar/Audora`
- Deployment branch: `codex/audora-marketing-music-showcase`
- Root Directory: `marketing`
- Framework: Next.js; install `npm ci`; build `npm run build`
- Adapter output: `.next`; generated static site: `out`

The complete bundled music is approximately 280.5 MiB. The connected team uses
Hobby, whose direct source-upload limit is 100 MB. Deployment therefore uses the
repository instead of a direct file upload.

Reference: [Vercel deployment limits](https://vercel.com/docs/limits).
