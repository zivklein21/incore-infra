import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { json } from '../lib/http';
import { runClassReminderEngine } from '../lib/classReminderEngine';

// GET or POST /testClassReminder — manual test trigger, no auth in the
// original, ported as-is and flagged.
export async function handler(_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await runClassReminderEngine();
  return json(200, result);
}
