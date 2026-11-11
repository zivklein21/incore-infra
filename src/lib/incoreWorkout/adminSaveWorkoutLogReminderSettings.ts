import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { normalizeWorkoutLogReminder, saveWorkoutLogReminderSettings } from '../notificationTiming';

// POST /adminSaveWorkoutLogReminderSettings
// Body: { enabled: boolean, delayMinutes: number }
// Auth: admin. Turns the INCORE workout-logging reminder on/off and sets how
// long after a class ends it goes out (lib/workoutLogReminder.ts). Read back
// through getNotificationTimingSettings's `workoutLogReminder` key.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (typeof body.enabled !== 'boolean') return json(400, { error: 'invalid_enabled' });

  const settings = normalizeWorkoutLogReminder(body);
  await saveWorkoutLogReminderSettings(settings);
  return json(200, { success: true, workoutLogReminder: settings });
}
