import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { json } from '../lib/http';
import { broadcastSpotOpen } from '../lib/waitlistCore';

// POST /triggerWaitlistOffer — admin/testing manual trigger.
// SECURITY NOTE: no auth in the original (functions/src/waitlist.ts), ported
// as-is and flagged, same as the other unauthenticated functions in this batch.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing classId' });
  }

  const classId = typeof body.classId === 'string' ? body.classId : '';
  if (!classId) return json(400, { error: 'Missing classId' });

  await broadcastSpotOpen(classId);
  return json(200, { success: true });
}
