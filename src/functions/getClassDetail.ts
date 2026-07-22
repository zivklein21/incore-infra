import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// GET or POST /getClassDetail?classId=xxx
// Auth: Cognito JWT (any signed-in member). Originally admin-only (the
// admin class-detail screen was its first caller) — now also backs
// useClientClassDetails.ts's booking-flow detail view, so it additionally
// resolves the caller's own registration status and the full waitlist
// (mirrors getClasses.ts's isBooked/consumedFrom/isWaitlisted, but for a
// single class plus waitlist position, which the list view doesn't need).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let bodyClassId = '';
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { classId?: unknown };
      bodyClassId = typeof body.classId === 'string' ? body.classId : '';
    } catch { /* fall through to query-param lookup */ }
  }
  const classId = event.queryStringParameters?.classId ?? bodyClassId;
  if (!classId) return json(400, { error: 'missing_class_id' });

  const [classRes, regRes] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
    })),
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CLASS#${classId}`, SK: `REG#${uid}` },
    })),
  ]);

  const item = classRes.Item as (ClassItem & {
    duration_min?: number; repeat_weekly?: boolean; notes?: string; series_id?: string | null;
  }) | undefined;
  if (!item) return json(404, { error: 'class_not_found' });

  const registration = regRes.Item as RegistrationItem | undefined;
  const isBooked = registration?.status === 'REGISTERED';

  const waitlist = item.waitlist ?? [];
  let isOnWaitlist = false;
  let waitlistStatus: string | null = null;
  let pendingSince: string | null = null;
  let waitlistPosition: number | null = null;
  let waitingRank = 0;
  for (const entry of waitlist) {
    const isMine = entry.member === uid;
    if (isMine) {
      isOnWaitlist = true;
      waitlistStatus = entry.status;
      if (entry.status === 'pending' && entry.pendingSince) pendingSince = entry.pendingSince;
      if (entry.status === 'waiting') waitlistPosition = waitingRank + 1;
    }
    if (entry.status === 'waiting' && !isMine) waitingRank++;
  }

  return json(200, {
    id: classId,
    classType: item.className ?? '',
    date: item.date,
    registered: item.currentAttendeesCount ?? 0,
    capacity: item.capacity ?? 5,
    durationMin: item.duration_min ?? 45,
    repeatWeekly: item.repeat_weekly ?? false,
    allowWaitlist: item.isWaitlistEnabled ?? false,
    notes: item.notes ?? '',
    seriesId: item.series_id ?? null,
    isBooked,
    bookedSource: isBooked ? registration?.consumedFrom ?? null : null,
    isOnWaitlist,
    waitlistStatus,
    pendingSince,
    waitlistPosition,
  });
}
