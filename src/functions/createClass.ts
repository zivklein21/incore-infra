import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr } from '../lib/entities';

// POST /createClass
// Auth: Cognito JWT, caller must be admin
// Body: { date: string (ISO 8601), capacity: number, className: string,
//          durationMin?: number, notes?: string, isWaitlistEnabled?: boolean,
//          seriesId?: string }
//
// Single-class create only — no server-side "repeat weekly" expansion (the
// old Firestore useCreateClass.ts looped client-side over deterministic
// weekly dates and called the equivalent of this once per date; the same
// approach works here — the client generates one seriesId and passes it on
// every call in the loop to tag the group, see useCreateClass.ts).
//
// GSI2PK/GSI2SK MUST be set exactly like this — bookClass.ts's same-day
// conflict check queries GSI2PK=CLASSDATE#<israelDateStr> directly, and
// would silently stop finding classes created without it.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: {
    date?: unknown; capacity?: unknown; className?: unknown; isWaitlistEnabled?: unknown;
    durationMin?: unknown; notes?: unknown; repeatWeekly?: unknown; seriesId?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const dateStr = typeof body.date === 'string' ? body.date : '';
  const parsedDate = dateStr ? new Date(dateStr) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) return json(400, { error: 'invalid_date' });

  const capacity = typeof body.capacity === 'number' && body.capacity > 0 ? body.capacity : 5;
  const className = typeof body.className === 'string' ? body.className.trim() : '';
  if (!className) return json(400, { error: 'missing_class_name' });
  const isWaitlistEnabled = body.isWaitlistEnabled === true;
  const durationMin = typeof body.durationMin === 'number' && body.durationMin > 0 ? body.durationMin : 45;
  const notes = typeof body.notes === 'string' ? body.notes : '';
  const repeatWeekly = body.repeatWeekly === true;
  const seriesId = typeof body.seriesId === 'string' && body.seriesId ? body.seriesId : null;

  const classId = randomUUID();

  const item: Record<string, unknown> = {
    PK: `CLASS#${classId}`,
    SK: 'METADATA',
    GSI2PK: `CLASSDATE#${israelDateStr(parsedDate)}`,
    GSI2SK: `CLASS#${classId}`,
    date: parsedDate.toISOString(),
    capacity,
    currentAttendeesCount: 0,
    className,
    duration_min: durationMin,
    notes,
    repeat_weekly: repeatWeekly,
    isWaitlistEnabled,
    waitlist: [],
    createdAt: new Date().toISOString(),
    createdBy: uid,
  };
  if (seriesId) item.series_id = seriesId;

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return json(200, { success: true, classId });
}
