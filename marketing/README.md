# Audora marketing

A standalone Next.js App Router site that exports static HTML to `out/`.
There is no server, API route, account system, tracking service, or dependency
on the Electron/Python app at runtime. The desktop application is unchanged.

## Local use

Requires Node.js 22 or later and npm.

```sh
cd marketing
npm ci
npm run dev
```

For the actual production output:

```sh
npm run build
npm run preview
```

The local server listens on `http://127.0.0.1:3000`. Stop the development server
before building or previewing.

## Validation

```sh
npm run build
npm run typecheck
npm run lint
npm run test:e2e
```

The browser suite uses installed Google Chrome through Playwright. It checks
320/390/768/1024/1440px layouts, platform links, keyboard operation and FAQ,
actual FLAC/MP3 playback, synchronized song changes, one audio element, public
asset URLs and byte ranges, reduced motion, WebGL fallback, on-demand loading,
idle rendering, metadata, missing pages, and static content without JavaScript.
It saves full-page captures under ignored `artifacts/`.

On this Windows workstation the global `npm.ps1` wrapper is broken. The working
equivalent is:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build
```

## Vercel configuration

- Repository: `utkarsh-wadalkar/Audora`
- Root Directory: **`marketing`**
- Framework Preset: **Next.js**
- Install Command: **`npm ci`**
- Build Command: **`npm run build`**
- Output Directory: **`.next`**, matching `vercel.json`. The Next.js adapter
  reads its build manifests there and detects the static export in `out/`.
- Node.js: **22.x or later**

Import the repository with those settings for Git deployments. The complete
music collection is about 280.5 MiB, including preserved FLAC files, so it exceeds
the Hobby plan's 100 MB limit for direct source uploads. Use a Git deployment for
the complete collection. All music files belong in the repository; no build or
runtime step downloads them from a separate service or local source folder.

The prepared project is `audora-music` under
`utkarshs-projects-d8755b84`, project ID `prj_hfyuslBaWyQlL9ilMmyCQd3C5Guq`.
Deploy the `codex/audora-marketing-music-showcase` branch through the connected
Git repository. Direct source upload is intentionally not used for this asset set.

`SITE_URL` is optional on Vercel. Set it to your canonical HTTPS origin when you
assign a custom domain. Otherwise metadata uses Vercel's production/project URL,
then the deployment URL. Local builds default to `http://localhost:3000`.
Canonical, Open Graph, structured data, and sitemap all use the same origin.

## Conversion readiness

All downloads link to the stable GitHub Releases page, including OS-specific
buttons. They do not construct versioned binary URLs. Release labels are
centralized in `lib/site.ts`; update `RELEASE_VERSION` when releasing the app.

`CtaLink` leaves anchor navigation intact and emits a local `audora:cta` event:

```js
window.addEventListener('audora:cta', ({ detail }) => {
  // Connect your chosen analytics service here later.
  // { id: 'download-windows', intent: 'download',
  //   platform: 'windows', href: 'https://github.com/.../releases' }
});
```

Every important CTA also exposes `id`, `data-cta`, `data-intent`, and where
applicable `data-platform`. This records outbound intent, not a completed binary
download. No visitor data is collected by the site itself.

## Design and maintenance

Most of the page is rendered by Server Components during build. The music
showcase and conversion link hooks are small isolated client components. Native
details/summary elements make FAQs work without JavaScript. Fonts and WebP assets
are local. The hero screenshot is preloaded; below-fold artwork is lazy loaded.
All images and the turntable stage have reserved dimensions.

Styling uses native CSS, Audora's charcoal/sand palette and Caveat wordmark,
with Geist for text. The static FLAC illustration describes the file format;
it is not a product mockup or measured audio waveform. CSS motion is short and
disabled under reduced motion. The approved turntable is modeled with Three.js
and React Three Fiber: graphite plinth, machined platter, record grooves, metal
tonearm, and the selected song's cover on the center label. It loads near the
viewport, renders on demand, stops drawing off screen, and falls back to a sharp
static poster when WebGL is unavailable. Audio still works with that fallback.

## Some Songs I Like

`lib/songs.generated.ts` is the single catalog for all 12 songs. Each item has an
ID, title, artist, relative audio/artwork URLs, duration, and source codec. There
is no album, artist, or folder grouping. The record shelf, selected title/cover,
3D label, and audio player all consume the same selected item.

The page owns exactly one HTML audio element with `preload="none"` and no initial
source. Start record plays it; Pause record pauses it. Selecting a card or using
Previous/Next replaces its source, retaining playback intent when it is already
playing. Ended tracks advance to the next song. Browser playback events drive
record animation. Reduced motion keeps audio available while the record stays
still. The scene is memoized so time/progress updates do not redraw WebGL.

The checked-in deployable structure is:

```text
public/music/<song-slug>/audio.flac  # Eight untouched FLAC copies
public/music/<song-slug>/audio.mp3   # Four ALAC compatibility copies
public/music/<song-slug>/cover.webp # Embedded artwork, 900 × 900
lib/songs.generated.ts             # One catalog, public URLs only
```

To regenerate during development, supply a source folder explicitly:

```sh
npm run prepare:music -- "<source-folder>"
```

This optional script uses `music-metadata`, `sharp`, and `ffmpeg-static` as
development tools. It preserves existing browser-compatible audio, creates MP3
VBR quality-2 copies only for unsupported ALAC, extracts real embedded artwork,
sanitizes slugs, and writes the catalog. It never modifies source files. Neither
`npm run build` nor the deployed application invokes it. No source-folder path
is stored in the catalog or client code. See `ASSETS.md` for provenance.

`ASSETS.md` documents screenshot provenance and capture regeneration. All product
claims follow the README, source, and v2.0.0 release. The site deliberately uses
“View on GitHub” rather than claiming an open-source license.
