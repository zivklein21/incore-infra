import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ClassItem } from '../lib/entities';
import { writeNotification, getMemberProfile } from '../lib/classNotifications';
import { resolveTemplate, getMemberLang, fmtTime, fmtDate, type TemplateVars } from '../lib/templateResolver';

// POST /sendBookCancelNotification
// SECURITY NOTE: same as sendClassCancelNotifications.ts — no auth in the
// original, ported as-is and flagged.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { classId?: unknown; memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing classId or memberId' });
  }

  const classId = typeof body.classId === 'string' ? body.classId : '';
  const memberId = typeof body.memberId === 'string' ? body.memberId : '';
  if (!classId || !memberId) return json(400, { error: 'Missing classId or memberId' });

  const [classRes, profile] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
    getMemberProfile(memberId),
  ]);

  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });
  if (!profile) return json(404, { error: 'member_not_found' });

  const classDate = new Date(classItem.date);
  const classType = classItem.className ?? '';
  const lang = getMemberLang(profile);
  const memberName = profile.name ?? '';

  const vars: TemplateVars = {
    class_type: classType,
    class_time: fmtTime(classDate),
    class_date: fmtDate(classDate, lang),
    member_name: memberName,
  };

  const resolved = await resolveTemplate('BOOK_CANCEL', lang, vars);
  if (resolved) {
    await writeNotification(memberId, classId, classType, classDate, resolved, 'cancel');
  }

  console.log(`[sendBookCancelNotification] member=${memberId}, class=${classId}`);
  return json(200, { success: true });
}
