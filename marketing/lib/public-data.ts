export type PublicEvidence = {
  activeVisitors30d: number;
  visitorsTotal: number;
  publishedReviews: number;
};

export type PublicReview = {
  id: number;
  name: string;
  role: string | null;
  rating: number;
  message: string;
  published_at: string | null;
};

type SupabaseConfig = { url: string; key: string };

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

async function callRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Public data is not configured.');

  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Public data request failed (${response.status}).`);
  const payload = await response.text();
  return (payload ? JSON.parse(payload) : undefined) as T;
}

export async function recordVisit(visitorId: string) {
  await callRpc<void>('record_site_visit', { p_visitor_id: visitorId });
}

export async function loadEvidence() {
  const [evidence, reviews] = await Promise.all([
    callRpc<PublicEvidence>('get_public_evidence', {}),
    callRpc<PublicReview[]>('get_public_reviews', { p_limit: 6 }),
  ]);
  return { evidence, reviews };
}

export async function submitFeedback(input: {
  submissionToken: string;
  name: string;
  email: string;
  role: string;
  rating: number;
  message: string;
  consentToPublish: boolean;
}) {
  await callRpc<void>('submit_feedback', {
    p_submission_token: input.submissionToken,
    p_name: input.name,
    p_email: input.email,
    p_role: input.role,
    p_rating: input.rating,
    p_message: input.message,
    p_consent_to_publish: input.consentToPublish,
  });
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
