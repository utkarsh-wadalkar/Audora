export type DailyVisitor = { date: string; count: number };

export type PublicEvidence = {
  thisMonth: number;
  lastMonth: number;
  visitorsTotal: number;
  publishedReviews: number;
  dailyVisitors: DailyVisitor[];
};

export type PublicReview = {
  id: number;
  name: string;
  role: string | null;
  rating: number;
  message: string;
  published_at: string | null;
};

async function callApi<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : { cache: 'no-store' });
  if (!response.ok) throw new Error(`Public data request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function recordVisit(visitorId: string) {
  await callApi<{ ok: true }>('/api/visits', { visitorId });
}

export function loadEvidence() {
  return callApi<{ evidence: PublicEvidence; reviews: PublicReview[] }>('/api/evidence');
}

export async function submitFeedback(input: {
  submissionToken: string;
  name: string;
  email: string;
  role: string;
  rating: number;
  message: string;
  consentToPublish: boolean;
  company: string;
}) {
  await callApi<{ ok: true }>('/api/feedback', input);
}

export async function loadGithubDownloadCount(): Promise<number> {
  const response = await fetch('https://api.github.com/repos/utkarsh-wadalkar/Audora/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);

  const releases = await response.json() as Array<{ draft: boolean; assets: Array<{ download_count: number }> }>;
  return releases
    .filter(release => !release.draft)
    .flatMap(release => release.assets)
    .reduce((total, asset) => total + asset.download_count, 0);
}
