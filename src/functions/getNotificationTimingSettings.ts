import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { getReminderSettings, getScheduleAlertSettings } from '../lib/notificationTiming';

// GET or POST /getNotificationTimingSettings
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// Reuses getReminderSettings()/getScheduleAlertSettings() from
// lib/notificationTiming.ts — the same PK=APPCONFIG, SK=NOTIFICATION_TIMING
// item and defaults already used server-side by classReminderEngine and
// scheduleAlertRoutine.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const [reminder, scheduleAlert] = await Promise.all([
    getReminderSettings(),
    getScheduleAlertSettings(),
  ]);

  return json(200, { reminder, scheduleAlert });
}
