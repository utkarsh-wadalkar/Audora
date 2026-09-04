import Image from 'next/image';
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, Disc3, Github, Monitor, Plus, Terminal } from 'lucide-react';
import { CtaLink } from '../components/cta-link';
import { ProductShowcase } from '../components/product-showcase';
import { GITHUB_URL, GUIDE_URL, RELEASES_URL, RELEASE_VERSION, SITE_URL, description } from '../lib/site';

function Wordmark() {
  return <span className="wordmark" translate="no">Audora<span className="wordmark-dot">.</span></span>;
}

function DownloadLink({ location, className = 'button button-primary' }: { location: string; className?: string }) {
  return <CtaLink href={RELEASES_URL} trackingId={`download-${location}`} intent="download" className={className}>
    <ArrowDownToLine size={17} aria-hidden="true" /> Download Audora
  </CtaLink>;
}

const questions = [
  { question: 'What is Audora?', answer: 'Audora is a desktop app for downloading music from Apple Music in lossless FLAC format and playing it locally. It brings downloads, your local library, and playback controls into one place.' },
  { question: 'Do I need an Apple Music subscription?', answer: 'Yes. You need your own active Apple Music subscription to download music. You sign in during setup inside the desktop app. Audora does not provide an Apple Music account or a subscription.' },
  { question: 'What do I need to get started?', answer: 'A Windows 10/11 x64 or Linux x64 computer, an internet connection, an active Apple Music subscription, and free space for setup and your music. You also need Docker Desktop on Windows or a running Docker Engine on Linux. The first-run wizard guides you through the required components and sign-in.' },
  { question: 'Can I play my downloads offline?', answer: 'Yes. Finished downloads are local FLAC files. Play them in Audora’s built-in player or another FLAC-compatible music player. An internet connection is needed to download new music.' },
  { question: 'Which download should I choose?', answer: 'On Windows, choose the x64 .exe installer. On Ubuntu or Debian, choose the .deb package. For other Linux distributions, choose the AppImage and make it executable before opening it. Audora currently supports x64 computers; there is no macOS or ARM build.' },
  { question: 'Is Audora free to use?', answer: 'Audora is free to download and use under its software license. Your Apple Music subscription is separate. The code and release history are available on GitHub; usage and redistribution are governed by the repository’s license.' },
];

export default function Home() {
  const structuredData = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Audora', url: SITE_URL,
    description, operatingSystem: 'Windows 10, Windows 11, Linux', applicationCategory: 'MultimediaApplication',
    softwareVersion: RELEASE_VERSION, downloadUrl: RELEASES_URL,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Audora is free. An active Apple Music subscription is required for downloads.' },
  };

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header">
      <div className="container nav-inner">
        <a className="brand-link" href="#" aria-label="Audora home"><Wordmark /></a>
        <nav aria-label="Main navigation">
          <a href="#experience">The experience</a><a href="#how-it-works">How it works</a><a href="#faq">FAQ</a>
        </nav>
        <DownloadLink location="nav" className="button button-small button-outline" />
      </div>
    </header>

    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="container hero-grid">
          <div className="hero-copy">
            <a className="release-note" href={`${GITHUB_URL}/releases/tag/v${RELEASE_VERSION}`}>
              <span className="release-dot" /> v{RELEASE_VERSION} <span className="release-divider">/</span> Made for the music <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <h1 id="hero-title">Music worth keeping.</h1>
            <p>Your Apple Music favorites, in lossless FLAC.<br className="desktop-break" /> Download, collect, and listen. All in one app.</p>
            <div className="hero-actions">
              <DownloadLink location="hero" />
              <CtaLink href={GITHUB_URL} trackingId="github-hero" intent="github" className="text-link"><Github size={17} aria-hidden="true" /> View on GitHub <ArrowUpRight size={14} aria-hidden="true" /></CtaLink>
            </div>
          </div>
          <div className="hero-visual">
            <div className="product-frame">
              <div className="frame-top"><span><span className="frame-status" /> Audora</span><span>YOUR EVERYDAY LISTENING, REFINED</span><span className="frame-window" aria-hidden="true">− &nbsp; □ &nbsp; ×</span></div>
              <Image className="hero-product" src="/images/audora-listen.webp" alt="The real Audora desktop interface, showing a demonstration album library and local playback controls."
                width={1440} height={900} sizes="(max-width: 767px) 94vw, (max-width: 1200px) 65vw, 800px" preload />
            </div>
            <div className="hero-visual-caption"><span>Good music deserves a good home.</span><a href="#experience">Take a closer look <ArrowDown size={13} aria-hidden="true" /></a></div>
          </div>
        </div>
        <div className="container product-facts" aria-label="Product essentials">
          <span><span className="fact-mark">FLAC</span> Every detail, preserved</span>
          <span><Disc3 size={18} aria-hidden="true" /> Download. Play. Keep listening.</span>
          <span><Monitor size={18} aria-hidden="true" /> Windows & Linux</span>
          <a href="#download">Bring your Apple Music account <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
      </section>

      <section id="experience" className="experience section container" aria-labelledby="experience-title">
        <div className="section-intro"><h2 id="experience-title">Some Songs<br />I Like.</h2><p>Twelve records from a personal rotation, ready to play.<br className="desktop-break" /> Choose one, lower the needle, and stay awhile.</p></div>
        <ProductShowcase />
      </section>

      <section id="how-it-works" className="workflow section" aria-labelledby="workflow-title">
        <div className="container">
          <div className="workflow-intro"><span className="eyebrow">LESS BETWEEN YOU AND THE MUSIC</span><h2 id="workflow-title">From found it.<br />To on repeat.</h2><p>A simple flow, from your first link to your next favorite album.</p></div>
          <ol className="workflow-steps">
            <li><div className="step-top"><span className="step-number">01</span><span className="step-line" /><ArrowRight size={18} aria-hidden="true" /></div><h3>Make yourself at home.</h3><p>Install Audora. Let the setup wizard guide you through Docker, the required components, and your Apple Music sign-in.</p><CtaLink href={GUIDE_URL} trackingId="setup-workflow" intent="setup" className="text-link">Read the setup guide <ArrowUpRight size={14} aria-hidden="true" /></CtaLink></li>
            <li><div className="step-top"><span className="step-number">02</span><span className="step-line" /><ArrowRight size={18} aria-hidden="true" /></div><h3>A link is all it takes.</h3><p>Copy a track, album, or playlist link from Apple Music. Paste it into Audora and start your lossless download.</p><span className="step-detail">Track · Album · Playlist</span></li>
            <li><div className="step-top"><span className="step-number">03</span><span className="step-line" /><Check size={18} aria-hidden="true" /></div><h3>Press play. Settle in.</h3><p>Each track is ready as soon as its FLAC conversion finishes. Open your library, choose an album, and let it play.</p><span className="step-detail">Saved locally. Ready to listen.</span></li>
          </ol>
        </div>
      </section>

      <section className="local-story section container" aria-labelledby="local-title">
        <div className="format-art" aria-hidden="true"><div className="format-spine">FREE LOSSLESS AUDIO CODEC</div><div className="format-face"><span className="format-caption">THE FULL PICTURE. IN EVERY NOTE.</span><span className="format-name">.flac</span><div className="format-wave">{Array.from({ length: 38 }, (_, index) => <i key={index} style={{ height: `${14 + Math.abs(Math.sin(index * 0.61) * Math.cos(index * 0.18)) * 72}%` }} />)}</div><div className="format-bottom"><span>LOSSLESS AUDIO</span><span>LOCAL FILES ↗</span></div></div></div>
        <div className="local-copy"><h2 id="local-title">Yours to play.<br /><span>Even offline.</span></h2><p>Audora saves your downloads as real FLAC files on your computer. Full lossless quality, with a built-in player ready when you are.</p><p>Listen in Audora. Open them in your favorite FLAC player. Build a collection that lives in your own folders.</p><a className="text-link" href="#download">Find your download <ArrowRight size={16} aria-hidden="true" /></a></div>
      </section>

      <section id="download" className="downloads section" aria-labelledby="download-title">
        <div className="container">
          <div className="section-intro"><span className="eyebrow">A LITTLE CLOSER TO YOUR MUSIC</span><h2 id="download-title">Meet your next music app.</h2><p>Choose your platform. Your library is waiting.</p></div>
          <div className="download-options">
            <article className="download-option windows-option"><div className="os-label"><span className="windows-symbol" aria-hidden="true"><i /><i /><i /><i /></span><span>Windows</span><span className="os-arch">x64</span></div><p>Windows 10 & 11</p><CtaLink href={RELEASES_URL} trackingId="download-windows" intent="download" platform="windows" className="button button-primary"><ArrowDownToLine size={17} aria-hidden="true" />Download Audora<span className="button-format">.exe</span></CtaLink><span className="package-name">Audora Setup {RELEASE_VERSION}.exe</span></article>
            <article className="download-option"><div className="os-label"><Terminal className="linux-symbol" size={24} aria-hidden="true" /><span>Linux</span><span className="os-arch">x64</span></div><p>Ubuntu, Debian & other distributions</p><div className="linux-buttons"><CtaLink href={RELEASES_URL} trackingId="download-linux-deb" intent="download" platform="linux-deb" className="button button-outline"><ArrowDownToLine size={16} aria-hidden="true" />.deb <span>Ubuntu / Debian</span></CtaLink><CtaLink href={RELEASES_URL} trackingId="download-linux-appimage" intent="download" platform="linux-appimage" className="button button-outline"><ArrowDownToLine size={16} aria-hidden="true" />AppImage <span>Other distros</span></CtaLink></div><span className="package-name">Choose your package on GitHub Releases</span></article>
          </div>
          <div className="requirements"><span className="requirements-title">Before you press play</span><p>An active Apple Music subscription, an internet connection, and Docker are required for setup and downloads. Use Docker Desktop on Windows or Docker Engine on Linux.</p><CtaLink href={GUIDE_URL} trackingId="setup-downloads" intent="setup" className="text-link">Setup guide <ArrowUpRight size={14} aria-hidden="true" /></CtaLink></div>
          <div className="release-footer"><span>Current release: v{RELEASE_VERSION} · Free to download</span><CtaLink href={RELEASES_URL} trackingId="github-release-notes" intent="github" className="text-link">Release notes <ArrowUpRight size={14} aria-hidden="true" /></CtaLink></div>
        </div>
      </section>

      <section id="faq" className="faq section container" aria-labelledby="faq-title">
        <div className="faq-intro"><h2 id="faq-title">A few things<br />to know.</h2><p>Good listening starts with<br className="desktop-break" /> knowing what to expect.</p><CtaLink href={GITHUB_URL} trackingId="github-faq" intent="github" className="text-link">View on GitHub <ArrowUpRight size={14} aria-hidden="true" /></CtaLink></div>
        <div className="faq-items">{questions.map(item => <details key={item.question} name="audora-faq"><summary>{item.question}<Plus size={18} aria-hidden="true" /></summary><p>{item.answer}</p></details>)}</div>
      </section>

      <section className="final-cta container" aria-labelledby="final-title"><div className="final-brand" aria-hidden="true"><Image src="/images/audora-icon.png" width={74} height={74} alt="" /></div><h2 id="final-title">Good music.<br /><span>Closer than ever.</span></h2><DownloadLink location="final" /><p>For Windows & Linux. Made for listening.</p></section>
    </main>

    <footer className="site-footer container"><div className="footer-main"><a href="#" className="brand-link" aria-label="Back to Audora home"><Wordmark /></a><span>A home for your music.</span><nav aria-label="Footer navigation"><a href={GITHUB_URL}>GitHub <ArrowUpRight size={12} aria-hidden="true" /></a><a href={`${GITHUB_URL}/blob/main/LICENSE`}>License</a><a href={GUIDE_URL}>Setup guide</a></nav></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Audora · Made by Utkarsh Wadalkar</span><p>Independent software. Not affiliated with Apple Inc. Apple Music is a trademark of Apple Inc.</p></div></footer>
  </>;
}
