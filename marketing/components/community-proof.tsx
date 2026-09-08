'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, Star } from 'lucide-react';
import { loadEvidence, loadGithubDownloadCount, recordVisit, type DailyVisitor, type PublicEvidence, type PublicReview } from '../lib/public-data';

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

function formatDay(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    .format(new Date(`${date}T12:00:00Z`));
}

function VisitorActivity({ visitors }: { visitors: DailyVisitor[] }) {
  const hasActivity = visitors.some(visitor => visitor.count > 0);
  const highestCount = Math.max(...visitors.map(visitor => visitor.count), 1);
  const points = visitors.map((visitor, index) => {
    const x = visitors.length > 1 ? (index / (visitors.length - 1)) * 100 : 50;
    const y = 86 - (visitor.count / highestCount) * 62;
    return { ...visitor, x, y };
  });
  const line = points.map(point => `${point.x},${point.y}`).join(' ');
  const middle = visitors[Math.floor(visitors.length / 2)];
  const chartSummary = hasActivity
    ? `Daily first-time browser visits from ${formatDay(visitors[0].date)} to ${formatDay(visitors[visitors.length - 1].date)}.`
    : 'No first-time browser visits have been captured in this two-week window yet.';

  return <div className="visitor-dashboard" aria-live="polite">
    <div className="visitor-dashboard-header">
      <div>
        <span className="eyebrow">Website activity</span>
        <strong>First-time visitors</strong>
      </div>
      <span className="activity-window">Last 14 days</span>
    </div>
    <div className="visitor-chart-wrap">
      <svg className="visitor-chart" viewBox="0 0 100 100" role="img" aria-labelledby="visitor-chart-title visitor-chart-description" preserveAspectRatio="none">
        <title id="visitor-chart-title">Daily first-time visitor activity</title>
        <desc id="visitor-chart-description">{chartSummary}</desc>
        <path className="visitor-chart-grid" d="M0 24H100M0 55H100M0 86H100" vectorEffect="non-scaling-stroke" />
        {hasActivity && <polyline className="visitor-chart-line" points={line} vectorEffect="non-scaling-stroke" />}
        {hasActivity && points.filter(point => point.count > 0).map(point => <circle key={point.date} className="visitor-chart-point" cx={point.x} cy={point.y} r="1.7" vectorEffect="non-scaling-stroke" />)}
      </svg>
      {!hasActivity && <p className="visitor-chart-empty">Activity will appear here as new listeners arrive.</p>}
    </div>
    <div className="visitor-chart-axis" aria-hidden="true">
      <span>{visitors[0] ? formatDay(visitors[0].date) : 'Start'}</span>
      <span>{middle ? formatDay(middle.date) : 'Midpoint'}</span>
      <span>{visitors[visitors.length - 1] ? formatDay(visitors[visitors.length - 1].date) : 'Today'}</span>
    </div>
    <p className="visitor-dashboard-note">Counts are unique browser IDs, grouped by first visit.</p>
  </div>;
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
          setStatus(supabaseResult.status === 'fulfilled' ? 'ready' : 'error');
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
        {status === 'loading'
          ? <div className="visitor-dashboard visitor-dashboard-loading" aria-label="Loading visitor activity"><span /><span /><span /></div>
          : <VisitorActivity visitors={evidence?.dailyVisitors ?? []} />}
      </div>
      <div className="community-copy">
        <h2 id="community-title">Built in public.<br /><span>Used in the real world.</span></h2>
        <p>A privacy-conscious view of real website activity, measured from each browser&apos;s first visit.</p>
        <div className="evidence-metrics" aria-live="polite">
          {status === 'loading' ? <>
            <span className="metric-skeleton" aria-label="Loading usage evidence" /><span className="metric-skeleton" /><span className="metric-skeleton" />
          </> : <>
            <div><strong>{evidence?.thisMonth.toLocaleString() ?? 'N/A'}</strong><span>This month</span></div>
            <div><strong>{evidence?.lastMonth.toLocaleString() ?? 'N/A'}</strong><span>Last month</span></div>
            <div><strong>{evidence?.visitorsTotal.toLocaleString() ?? 'N/A'}</strong><span>Total</span></div>
          </>}
        </div>
        {status === 'error' && <p className="evidence-error" role="status">Live counts are temporarily unavailable.</p>}
        <a className="text-link evidence-source" href="https://github.com/utkarsh-wadalkar/Audora/releases">
          {downloads === null ? 'Verify releases on GitHub' : `${downloads.toLocaleString()} verified release downloads on GitHub`} <ArrowUpRight size={14} aria-hidden="true" />
        </a>
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
