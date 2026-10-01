# Audora marketing

A standalone Next.js App Router site. Vercel Web Analytics records page visits
through the official `@vercel/analytics` package. TiDB stores anonymous activity
and the feedback inbox. The desktop application is unchanged.

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
  serves the static page and the TiDB-backed route handlers from this build.
- Node.js: **22.x or later**

Import the repository with those settings for Git deployments. The complete
music collection is about 280.5 MiB, including preserved FLAC files, so it exceeds
the Hobby plan's 100 MB limit for direct source uploads. Use a Git deployment for
the complete collection. All music files belong in the repository; no build or
runtime step downloads them from a separate service or local source folder.

The prepared project is `audora-music` under
`utkarshs-projects-d8755b84`, project ID `prj_hfyuslBaWyQlL9ilMmyCQd3C5Guq`.
Production deploys the `main` branch through the connected Git repository.
Direct source upload is intentionally not used for this asset set.

`SITE_URL` is optional on Vercel. Set it to your canonical HTTPS origin when you
assign a custom domain. Otherwise metadata uses Vercel's production/project URL,
then the deployment URL. Local builds default to `http://localhost:3000`.
Canonical, Open Graph, structured data, and sitemap all use the same origin.

The live evidence and feedback components require this server-only Production variable:

```text
TIDB_DATABASE_URL
```

The TiDB URL is used only by Next.js route handlers. Never use a `NEXT_PUBLIC_`
database variable or expose the password to browser code. The schema is in
`tidb/schema.sql`; consented reviews can be reviewed with
`tidb/review-consented.sql`.

## Conversion readiness

All downloads link to the stable GitHub Releases page, including OS-specific
buttons. They do not construct versioned binary URLs. Release labels are
centralized in `lib/site.ts`; update `RELEASE_VERSION` when releasing the app.

`CtaLink` leaves anchor navigation intact and emits a local `audora:cta` event:

```js
window.addEventListener('audora:cta', ({ detail }) => {
  // Optionally bridge this detail to a custom analytics event.
  // { id: 'download-windows', intent: 'download',
  //   platform: 'windows', href: 'https://github.com/.../releases' }
});
```

Every important CTA also exposes `id`, `data-cta`, `data-intent`, and where
applicable `data-platform`. GitHub's release API is the source of completed asset
download counts. Audora stores a random browser identifier and timestamps only;
it does not store an IP address or profile with the activity record.

## Feedback and review moderation

Feedback is written only to the private `feedback_submissions` table. A
submission cannot appear publicly unless the listener checked the
publication-consent box and you explicitly change its status from `pending` to
`published`.

Run `marketing/tidb/review-consented.sql` in TiDB Cloud SQL Editor to see the
consented pending queue. Review each row, then run the commented `UPDATE` with
only the IDs you approve. The public evidence endpoint returns those selected
rows on the next page refresh. Never publish the private `email` or
`submission_token` columns.

## Design and maintenance

Most of the page is rendered by Server Components during build. Conversion link
hooks are small isolated client components. Native
details/summary elements make FAQs work without JavaScript. Fonts and WebP assets
are local. The hero screenshot is preloaded. All images have reserved dimensions.

Styling uses native CSS, Audora's charcoal/sand palette and Caveat wordmark,
with Geist for text. The static FLAC illustration describes the file format;
it is not a product mockup or measured audio waveform. CSS motion is short and
disabled under reduced motion. The listening section currently shows a placeholder
while a rights-cleared lossless demo is prepared.

## Listening demo

The previous music files, covers, catalog, and turntable poster were removed from
the deployable site. Requests to their former `/music/` and poster URLs should
return 404 after deployment. The `#experience` section remains as a placeholder.

To regenerate during development, supply a source folder explicitly:

```sh
npm run prepare:music -- "<source-folder>"
```

This optional script uses `music-metadata`, `sharp`, and `ffmpeg-static` as
development tools. It is not invoked by the build or deployed application. Only
run it with music and artwork cleared for public distribution. See `ASSETS.md`
for current asset provenance.

`ASSETS.md` documents screenshot provenance and capture regeneration. All product
claims follow the README, source, and v2.0.0 release. The site deliberately uses
“View on GitHub” rather than claiming an open-source license.
