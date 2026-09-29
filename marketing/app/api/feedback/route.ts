import { isUuid, jsonInput, sameOrigin } from '../../../lib/api-input';
import { saveFeedback } from '../../../lib/tidb';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const input = await jsonInput(request);
  if (!input) return Response.json({ error: 'Invalid input' }, { status: 400 });
  if (input.company) return Response.json({ ok: true });

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const role = typeof input.role === 'string' ? input.role.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!isUuid(input.submissionToken) || name.length < 2 || name.length > 80 ||
    email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    role.length > 100 || !Number.isInteger(input.rating) ||
    Number(input.rating) < 1 || Number(input.rating) > 5 ||
    message.length < 20 || message.length > 1200 ||
    typeof input.consentToPublish !== 'boolean') {
    return Response.json({ error: 'Invalid feedback' }, { status: 400 });
  }

  try {
    await saveFeedback({
      submissionToken: input.submissionToken,
      name, email: email || null, role: role || null,
      rating: Number(input.rating), message, consentToPublish: input.consentToPublish,
    });
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Unable to save feedback:', error);
    return Response.json({ error: 'Feedback unavailable' }, { status: 503 });
  }
}
