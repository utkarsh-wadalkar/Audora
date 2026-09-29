import { isUuid, jsonInput, sameOrigin } from '../../../lib/api-input';
import { saveVisit } from '../../../lib/tidb';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const input = await jsonInput(request);
  if (!isUuid(input?.visitorId)) return Response.json({ error: 'Invalid visitor ID' }, { status: 400 });
  try {
    await saveVisit(input.visitorId);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Unable to record visit:', error);
    return Response.json({ error: 'Visit unavailable' }, { status: 503 });
  }
}
