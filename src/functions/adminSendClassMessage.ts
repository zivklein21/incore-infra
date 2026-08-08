import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem } from '../lib/entities';

// POST /adminSendClassMessage
// Body: { memberIds, classId, classType, classDate, msgType, title, body, bgColor, textColor }
// Auth: Cognito JWT, caller must be admin
//
// Replaces ClassActionSheet.tsx's writeMessageToMembers — sends an
// admin-composed (template-derived or custom) message to a specific set of
// members (a class's roster or waitlist), with {member_name} substituted
// per-recipient. Distinct from triggerTemplateAlert.ts, which blasts one
// template to every member rather than a specific list.
function firstName(fullName: string): string {
  return fullName.split(' ')[0] ?? '';
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberIds?: unknown; classId?: unknown; classType?: unknown; classDate?: unknown;
    msgType?: unknown; title?: unknown; body?: unknown; bgColor?: unknown; textColor?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberIds = Array.isArray(body.memberIds) ? body.memberIds.filter((x): x is string => typeof x === 'string') : [];
  const classId = typeof body.classId === 'string' ? body.classId : '';
  const classType = typeof body.classType === 'string' ? body.classType : '';
  const classDate = typeof body.classDate === 'string' ? body.classDate : new Date().toISOString();
  const msgType = typeof body.msgType === 'string' ? body.msgType : 'custom';
  const title = typeof body.title === 'string' ? body.title : '';
  const text = typeof body.body === 'string' ? body.body : '';
  const bgColor = typeof body.bgColor === 'string' ? body.bgColor : '#5C3A8F';
  const textColor = typeof body.textColor === 'string' ? body.textColor : '#FFFFFF';
  if (memberIds.length === 0) return json(400, { error: 'missing_member_ids' });

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await Promise.all(memberIds.map(async (id) => {
    const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${id}`, SK: 'PROFILE' } }));
    const profile = res.Item as MemberProfileItem | undefined;
    const fullName = profile ? deriveMemberName(profile) : '';
    const fn = firstName(fullName);
    const personalizedTitle = title.replace(/\{member_name\}/g, fn);
    const personalizedBody = text.replace(/\{member_name\}/g, fn);

    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${id}`,
        SK: `MESSAGE#${randomUUID()}`,
        type: msgType,
        title: personalizedTitle,
        body: personalizedBody,
        bgColor,
        textColor,
        classId,
        className: classType,
        classDate,
        createdAt: nowIso,
        expiresAt,
        requiresAction: false,
        read: false,
      },
    }));
  }));

  return json(200, { success: true, sentCount: memberIds.length });
}
