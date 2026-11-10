import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { israelDateStr } from '../israelTime';
import { parseBrand } from './shared';
import { formsTable } from './submissions';

// GET /adminListActivities?brand=incore|forca&days=60
// Auth: Cognito JWT, admin only. Upcoming activities from the calendar
// (sessions / classes, today onward) for the "Assign → An activity" picker:
// { activities: [{ classId, className, date, registered, special, location, description, groupName,
//                 endDate, transport, safetyNotes, traineeEquipment }] },
// soonest first (special = created in Manage → Activities).
// One query per day on GSI2 (CLASSDATE#<date> — see sessionInstance.ts),
// the same per-day index bookings use; at most 90 days.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const brand = parseBrand(event.queryStringParameters?.brand);
  const days = Math.min(Math.max(Number(event.queryStringParameters?.days) || 60, 1), 90);

  const perDay = await Promise.all(Array.from({ length: days }, async (_, i) => {
    const res = await ddb.send(new QueryCommand({
      TableName: formsTable(brand),
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `CLASSDATE#${israelDateStr(i)}` },
    }));
    return res.Items ?? [];
  }));

  const now = new Date().toISOString();
  const activities = perDay.flat()
    .filter(c => String(c.SK) === 'METADATA' && String(c.PK).startsWith('CLASS#') && String(c.date ?? '') >= now && !c.cancelled && !c.isCancelled)
    .map(c => ({
      classId: String(c.PK).replace(/^CLASS#/, ''),
      className: typeof c.className === 'string' ? c.className : '',
      date: String(c.date),
      registered: typeof c.currentAttendeesCount === 'number' ? c.currentAttendeesCount : 0,
      special: c.isSpecialActivity === true,
      location: typeof c.location === 'string' ? c.location : '',
      description: typeof c.description === 'string' ? c.description : '',
      groupName: typeof c.notes === 'string' ? c.notes : '',
      // Special activities' editable details (Manage → Activities → Edit) — additive.
      endDate: typeof c.endDate === 'string' ? c.endDate : null,
      transport: typeof c.transport === 'string' ? c.transport : '',
      safetyNotes: typeof c.safetyNotes === 'string' ? c.safetyNotes : '',
      traineeEquipment: Array.isArray(c.traineeEquipment) ? c.traineeEquipment.filter((x: unknown) => typeof x === 'string') : [],
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return json(200, { activities });
}
