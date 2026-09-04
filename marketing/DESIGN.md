# Audora marketing site

The page moves from understanding Audora to seeing the actual interface,
understanding setup, and choosing a GitHub release. It is a separate static
Next.js application; desktop source and packaging remain independent.

Design: near-black and charcoal, warm white type, sand/amber drawn from the
existing Caveat wordmark. Geist provides readable display and body typography.
Use an asymmetric hero with a real renderer capture, then the approved 3D
turntable, a numbered workflow, a playback story, platform downloads, native FAQ
disclosures, and a final CTA. Buttons are pills, product frames use 16px corners.
Motion intensity is 3/10 and supports reduced motion. The turntable is the only
WebGL scene; no shader-background or glass-effect package is needed.

The user approved the turntable and expanded its section into “Some Songs I Like.”
Preserve its graphite/silver materials, lighting, camera, drag interaction and
reset control. Present each of the 12 songs as its own cover-and-vinyl card.
Use one selected-song state and one audio element for selection, title/artwork,
the 3D record label, Play/Pause, Previous/Next and playback animation. Copy assets
into the project during development. Keep FLAC originals lossless and create
browser-compatible copies only for ALAC sources. Never depend on the source
folder at runtime. Audio loads on demand; animation pauses outside the viewport.

Product screenshots must come from the actual renderer, with a demonstration
catalog clearly identified in captions. Do not use personal runtime databases,
credentials, synthetic interface drawings, unsupported claims, fabricated social
proof, or fabricated performance metrics. The current restrictive license means
the page links to GitHub without claiming an open-source license.

Every download points to the stable GitHub releases page. Before downloading,
visitors can see the Apple Music subscription, Docker, and x64 requirements.
No sign-up, remote application API, or runtime backend is required. Vercel Web
Analytics measures visits through the statically deployed marketing site.

## Implementation and validation plan

- [x] Capture real app Library, Listen, and Download screens with a demo catalog.
- [x] Build static page and small isolated interaction components in marketing/.
- [x] Replace the screenshot-tab section with the approved custom 3D turntable.
- [x] Extend the turntable into Some Songs I Like with actual bundled audio.
- [x] Add self-hosted branding/fonts, optimized images, metadata, OG, robots,
      sitemap, stable CTA identifiers, and documented optional conversion events.
- [x] Build, typecheck, lint; inspect desktop and mobile with browser tools.
- [x] Verify disclosures, keyboard focus, internal/external links, reduced motion,
      overflow, console errors, accessibility, and load performance.
- [ ] Deploy the isolated site to Vercel and document the exact project/build path.

The full bundled music exceeds Vercel Hobby's direct-upload limit. Deployment
uses a Git-backed Vercel project with Root Directory `marketing`.
