import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// GET or POST /getMemberMessages
// Auth: Cognito JWT (own messages only)
// PK=MEMBER#<uid> SK=MESSAGE#<id> — in-app notification messages (waitlist
// offers, schedule changes, admin broadcasts). No AWS WebSocket transport
// exists yet, so the client polls this instead of the old Firestore
// onSnapshot listener.
//
// Messages live in whichever table the member's own profile lives in — a
// FORCA trainee's broadcasts are written to FORCA_TABLE_NAME (see
// templateBroadcast.ts), so this can't just hardcode the incore table
// anymore. resolveMemberProfile() checks both tables for this uid (no
// brand-aware signal on the JWT itself — see its own comment).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(200, { messages: [] });

  const res = await ddb.send(new QueryCommand({
    TableName: resolved.table,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'MESSAGE#' },
  }));

  const now = new Date();
  const messages = ((res.Items ?? []) as Record<string, unknown>[])
    .filter((m) => !m.expiresAt || new Date(m.expiresAt as string) > now)
    .map((m) => ({
      id: (m.SK as string).replace('MESSAGE#', ''),
      type: m.type,
      title: m.title ?? '',
      body: m.body ?? '',
      bgColor: m.bgColor,
      textColor: m.textColor,
      classId: m.classId,
      className: m.className,
      classDate: m.classDate ?? null,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt ?? null,
      requiresAction: !!m.requiresAction,
      actionExpiresAt: m.actionExpiresAt ?? null,
      read: !!m.read,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return json(200, { messages });
}
