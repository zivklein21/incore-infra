import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr, type ClassItem, type RecurringSessionItem } from '../lib/entities';
import { createSessionInstance, occurrencesInMonth } from '../lib/sessionInstance';

// POST /adminGenerateMonthInstances
// Body: { year: number, month: number (1-12) }
// Auth: Cognito JWT, caller must be admin
//
// Bulk-pushes an entire calendar month's worth of dated ClassItem instances
// onto the calendar in one action, for EVERY active RecurringSessionItem
// template — the Monthly Calendar's "add a whole month at once" action.
// adminSaveRecurringSession.ts's own generation is capped to "from today
// through the end of the current month" (see upcomingOccurrences()), so a
// future month (or a month an admin wants filled in ahead of time) never
// gets instances until this runs. occurrencesInMonth() computes every
// matching weekday/time in the requested month regardless of "today";
// each candidate date is skipped if that exact recurring session already
// has an instance there (checked via the existing GSI2 CLASSDATE# index,
// same pattern adminAddToClass.ts uses for same-day lookups), so calling
// this again for a month that's partially filled only fills the gaps.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { year?: unknown; month?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const year = typeof body.year === 'number' ? body.year : NaN;
  const month = typeof body.month === 'number' ? body.month : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: 'invalid_year' });
  if (!Number.isInteger(month) || month < 1 || month > 12) return json(400, { error: 'invalid_month' });

  const templatesRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :meta AND active = :active',
    ExpressionAttributeValues: { ':prefix': 'RECURRINGSESSION#', ':meta': 'METADATA', ':active': true },
  }));
  const templates = (templatesRes.Items ?? []) as RecurringSessionItem[];

  let instancesCreated = 0;
  let registeredCount = 0;
  let skipped = 0;

  for (const template of templates) {
    const recurringSessionId = template.PK.replace('RECURRINGSESSION#', '');
    for (const date of occurrencesInMonth(year, month, template.dayOfWeek, template.time)) {
      const dateStr = israelDateStr(date);
      const sameDayRes = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `CLASSDATE#${dateStr}` },
      }));
      const alreadyExists = (sameDayRes.Items as ClassItem[] | undefined ?? [])
        .some((item) => item.recurringSessionId === recurringSessionId);
      if (alreadyExists) { skipped += 1; continue; }

      const result = await createSessionInstance({
        groupId: template.groupId,
        trainingTypeId: template.trainingTypeId,
        date,
        createdBy: callerUid,
        location: template.location,
        coachId: template.coachId,
        coachName: template.coachName,
        recurringSessionId,
      });
      if (result.ok) {
        instancesCreated += 1;
        registeredCount += result.registeredCount;
      } else {
        skipped += 1;
      }
    }
  }

  return json(200, { success: true, instancesCreated, registeredCount, skipped });
}
