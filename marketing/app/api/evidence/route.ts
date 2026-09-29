import { getEvidence } from '../../../lib/tidb';

export async function GET() {
  try {
    return Response.json(await getEvidence(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Unable to load evidence:', error);
    return Response.json({ error: 'Evidence unavailable' }, { status: 503 });
  }
}
