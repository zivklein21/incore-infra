import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import { deriveMemberName, type ClassItem } from '../lib/entities';
import { extractMemberIds, writeNotification, getMemberProfile } from '../lib/classNotifications';
import { resolveTemplate, getMemberLang, fmtTime, fmtDate, type TemplateVars } from '../lib/templateResolver';

// POST /sendClassCancelNotifications
//
// SECURITY NOTE ported as-is: this endpoint has NO authentication in the
// original (functions/src/cancelNotifications.ts) despite the docstring
// saying "called by the admin" — no verifyIdToken, no admin check at all.
// Preserved exactly; flagging for follow-up (e.g. gating behind Cognito JWT
// + isAdmin like the other admin* functions in this batch).
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing classId' });
  }

  const classId = typeof body.classId === 'string' ? body.classId : '';
  if (!classId) return json(400, { error: 'Missing classId' });

  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const classDate = new Date(classItem.date);
  const classType = classItem.className ?? '';
  const memberIds = await extractMemberIds(classId, classItem);

  if (memberIds.length === 0) return json(200, { success: true, notified: 0 });

  const profiles = await Promise.all(memberIds.map((id) => getMemberProfile(id)));

  await Promise.all(profiles.map(async (profile, i) => {
    if (!profile) return;
    const lang = getMemberLang(profile);
    const memberName = deriveMemberName(profile);

    const vars: TemplateVars = {
      class_type: classType,
      class_time: fmtTime(classDate),
      class_date: fmtDate(classDate, lang),
      member_name: memberName,
    };

    const resolved = await resolveTemplate('CLASS_CANCEL', lang, vars);
    if (!resolved) return;

    await writeNotification(memberIds[i], classId, classType, classDate, resolved, 'cancel');
  }));

  console.log(`[sendClassCancelNotifications] class=${classId} — notified ${memberIds.length} members`);
  return json(200, { success: true, notified: memberIds.length });
}
