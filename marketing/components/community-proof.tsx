'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Star } from 'lucide-react';
import { loadEvidence, loadGithubDownloadCount, recordVisit, type PublicEvidence, type PublicReview } from '../lib/public-data';

function visitorId() {
  const key = 'audora-visitor-id';
  const created = window.crypto.randomUUID();
  try {
    const saved = window.localStorage.getItem(key);
    if (saved) return saved;
    window.localStorage.setItem(key, created);
  } catch {
    return created;
  }
  return created;
}

function Stars({ rating }: { rating: number }) {
  return <span className="review-stars" aria-label={`${rating} out of 5 stars`}>
    {Array.from({ length: 5 }, (_, index) => <Star key={index} size={14} fill={index < rating ? 'currentColor' : 'none'} aria-hidden="true" />)}
  </span>;
}

export function CommunityProof() {
  const [evidence, setEvidence] = useState<PublicEvidence | null>(null);
  const [downloads, setDownloads] = useState<number | null>(null);
  const [reviews, setReviews] = useState<PublicReview[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        await recordVisit(visitorId()).catch(() => undefined);
        const [supabaseResult, githubResult] = await Promise.allSettled([
          loadEvidence(),
          loadGithubDownloadCount(),
        ]);
        if (!cancelled) {
          if (supabaseResult.status === 'fulfilled') {
            setEvidence(supabaseResult.value.evidence);
            setReviews(supabaseResult.value.reviews);
          }
          if (githubResult.status === 'fulfilled') setDownloads(githubResult.value);
          setStatus(supabaseResult.status === 'fulfilled' && githubResult.status === 'fulfilled' ? 'ready' : 'error');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    }
    void refresh();
    return () => { cancelled = true; };
  }, []);

  return <section id="community" className="community section" aria-labelledby="community-title">
    <div className="container community-grid">
      <div className="community-visual">
        <Image src="/images/audora-download.webp" width={1440} height={900}
          sizes="(max-width: 767px) 100vw, 48vw" alt="Audora's real download workspace showing a lossless music transfer." />
      </div>
      <div className="community-copy">
        <h2 id="community-title">Built in public.<br /><span>Used in the real world.</span></h2>
        <p>Live, source-backed signals from the Audora website and GitHub releases.</p>
        <div className="evidence-metrics" aria-live="polite">
          {status === 'loading' ? <>
            <span className="metric-skeleton" aria-label="Loading usage evidence" /><span className="metric-skeleton" /><span className="metric-skeleton" />
          </> : <>
            <div><strong>{evidence?.activeVisitors30d.toLocaleString() ?? 'N/A'}</strong><span>Visitors in 30 days</span></div>
            <div><strong>{downloads?.toLocaleString() ?? 'N/A'}</strong><span>Release downloads</span></div>
            <div><strong>{evidence?.publishedReviews.toLocaleString() ?? 'N/A'}</strong><span>Published reviews</span></div>
          </>}
        </div>
        {status === 'error' && <p className="evidence-error" role="status">Live counts are temporarily unavailable.</p>}
        <a className="text-link evidence-source" href="https://github.com/utkarsh-wadalkar/Audora/releases">Verify releases on GitHub <ArrowUpRight size={14} aria-hidden="true" /></a>
      </div>
    </div>

    <div className="container reviews-block">
      <h3>What listeners say</h3>
      {status === 'loading' ? <div className="review-loading" aria-label="Loading listener reviews"><span /><span /></div>
        : reviews === null ? <p className="reviews-empty">Listener reviews are temporarily unavailable.</p>
        : reviews.length > 0 ? <div className="review-rail">
          {reviews.map(review => <figure className="review-card" key={review.id}>
            <Stars rating={review.rating} />
            <blockquote>“{review.message}”</blockquote>
            <figcaption><strong>{review.name}</strong>{review.role && <span>{review.role}</span>}</figcaption>
          </figure>)}
        </div> : <p className="reviews-empty">No listener reviews have been published yet. Submitted reviews appear here only after consent and moderation.</p>}
    </div>
  </section>;
}
