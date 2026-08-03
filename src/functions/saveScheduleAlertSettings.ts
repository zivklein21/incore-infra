import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { patchScheduleAlertSettings } from '../lib/notificationTiming';

function isIntInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// POST /saveScheduleAlertSettings
// Body: ScheduleAlertSettings minus lastSentKey (that field is only ever
// written internally by scheduleAlertRoutine.ts) — see
// lib/notificationTiming.ts for the shared PK=APPCONFIG, SK=NOTIFICATION_TIMING
// item and patchScheduleAlertSettings' shallow-merge write. A one-off,
// different-time send is a manual "Send Now" action, not part of this
// standing weekly schedule.
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'permission-denied' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid-argument' });
  }

  const { enabled, templateId, weekday, hour, minute } = body;

  if (
    typeof enabled !== 'boolean' ||
    !(templateId === null || typeof templateId === 'string') ||
    !isIntInRange(weekday, 0, 6) ||
    !isIntInRange(hour, 0, 23) ||
    !isIntInRange(minute, 0, 59)
  ) {
    return json(400, { error: 'invalid-argument' });
  }

  await patchScheduleAlertSettings({ enabled, templateId, weekday, hour, minute });

  return json(200, { success: true });
}
