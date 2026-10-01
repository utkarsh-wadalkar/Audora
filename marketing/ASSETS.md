# Asset provenance

The three `public/images/audora-*.webp` screen captures were made from the
repository's unmodified React/Vite desktop renderer on 2026-09-03, at 1440 × 900.
`scripts/capture-product.mjs` supplies a demonstration catalog through intercepted
HTTP requests in an isolated headless browser. It does not start the backend or
read personal music, settings, databases, sessions, or credentials.

Album metadata and artwork in the demonstration catalog come from Apple's public
iTunes metadata API. The artwork is shown within the actual product interface;
it is not distributed as standalone marketing artwork. No audio was downloaded.
The screenshots demonstrate the renderer, not a completed live download test.
The page labels the catalog as a demonstration.

The source queries are Random Access Memories (Daft Punk), Currents (Tame
Impala), In Rainbows (Radiohead), Bon Iver, Khruangbin, and Frank Ocean. The capture
script saves exact catalog records and sources under ignored `artifacts/capture/`.
Public catalog results can change; the checked-in captures are stable assets.

`public/images/audora-icon.png` is copied from `frontend/assets/audoralogo.png`.
The favicon and Apple touch icon are resized versions of that existing asset.
`app/fonts/caveat-700.woff2` is copied from the desktop renderer's existing font.
Geist is self-hosted from `@fontsource-variable/geist` and its OFL license is
included alongside the font. UI glyphs come from Lucide.

`public/social-preview.png` is a browser-rendered composition of the existing
wordmark, page typography, and actual Listen screenshot. Regenerate it using
`node scripts/social-card.mjs` after replacing product captures.

## Listening room

The former public music showcase and its embedded artwork were removed pending a
rights-cleared replacement. The `/music/` directory is not deployed. The page
keeps a short placeholder at `#experience` so navigation remains usable.

The original procedural turntable code remains in `components/turntable-scene.tsx`
for a future listening demo. It is not rendered or loaded by the current page.
`scripts/prepare-music.mjs` is a development tool only; do not use it to publish
recordings or artwork without documented rights for public distribution.
