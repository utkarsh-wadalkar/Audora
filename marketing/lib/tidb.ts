import 'server-only';
import { connect } from '@tidbcloud/serverless';
import type { DailyVisitor, PublicEvidence, PublicReview } from './public-data';

function database() {
  const url = process.env.TIDB_DATABASE_URL;
  if (!url) throw new Error('TIDB_DATABASE_URL is not configured.');
  return connect({ url });
}

function utcSql(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function saveVisit(visitorId: string) {
  await database().execute(
    `INSERT INTO site_visitors (visitor_id, first_seen, last_seen)
     VALUES (?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(6)`,
    [visitorId],
  );
}

export async function getEvidence(): Promise<{ evidence: PublicEvidence; reviews: PublicReview[] }> {
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const firstDay = new Date(tomorrow.getTime() - 14 * 86_400_000);
  const db = database();

  const [totals, activity, reviewCount, publicReviews] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS visitorsTotal,
        COALESCE(SUM(first_seen >= ?), 0) AS thisMonth,
        COALESCE(SUM(first_seen >= ? AND first_seen < ?), 0) AS lastMonth
      FROM site_visitors`, [utcSql(thisMonth), utcSql(lastMonth), utcSql(thisMonth)]),
    db.execute(`SELECT DATE_FORMAT(first_seen, '%Y-%m-%d') AS day, COUNT(*) AS count
      FROM site_visitors WHERE first_seen >= ? AND first_seen < ?
      GROUP BY day ORDER BY day`, [utcSql(firstDay), utcSql(tomorrow)]),
    db.execute(`SELECT COUNT(*) AS count FROM feedback_submissions
      WHERE status = 'published' AND consent_to_publish = TRUE`),
    db.execute(`SELECT id, name, role, rating, message,
        DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%sZ') AS published_at
      FROM feedback_submissions
      WHERE status = 'published' AND consent_to_publish = TRUE
      ORDER BY published_at DESC, id DESC LIMIT 6`),
  ]);

  const total = totals[0] as Record<string, unknown>;
  const counts = new Map(activity.map(row => {
    const item = row as Record<string, unknown>;
    return [String(item.day), Number(item.count)] as const;
  }));
  const dailyVisitors: DailyVisitor[] = Array.from({ length: 14 }, (_, index) => {
    const day = dateKey(new Date(firstDay.getTime() + index * 86_400_000));
    return { date: day, count: counts.get(day) ?? 0 };
  });

  return {
    evidence: {
      thisMonth: Number(total.thisMonth),
      lastMonth: Number(total.lastMonth),
      visitorsTotal: Number(total.visitorsTotal),
      publishedReviews: Number((reviewCount[0] as Record<string, unknown>).count),
      dailyVisitors,
    },
    reviews: publicReviews.map(row => {
      const item = row as Record<string, unknown>;
      return {
        id: Number(item.id), name: String(item.name),
        role: item.role == null ? null : String(item.role),
        rating: Number(item.rating), message: String(item.message),
        published_at: item.published_at == null ? null : String(item.published_at),
      } satisfies PublicReview;
    }),
  };
}

export async function saveFeedback(input: {
  submissionToken: string;
  name: string;
  email: string | null;
  role: string | null;
  rating: number;
  message: string;
  consentToPublish: boolean;
}) {
  await database().execute(
    `INSERT INTO feedback_submissions
      (submission_token, name, email, role, rating, message, consent_to_publish, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE submission_token = submission_token`,
    [input.submissionToken, input.name, input.email, input.role,
      input.rating, input.message, input.consentToPublish],
  );
}
