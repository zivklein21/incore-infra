import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /adminDeleteMember
// Body: { memberId }
// Auth: Cognito JWT, caller must be admin
//
// Permanently removes a member: deletes every still-active registration
// (decrementing the class's attendee count for REGISTERED ones — cancelled
// registrations are already gone from REG# by the time they're cancelled,
// see adminCancelRegistration.ts's Delete), strips them from every class's
// waitlist, then deletes the profile itself. Does NOT delete their
// cancellation history (CANCEL# items) or membership history — those stay
// as an audit trail, matching the old Firestore version leaving the
// cancellations subcollection alone.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const [regsRes, classesRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#' },
    })),
    ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
    })),
  ]);

  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  const classes = (classesRes.Items ?? []) as ClassItem[];

  await Promise.all([
    ...registrations.map(async (r) => {
      if (r.status === 'REGISTERED') {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' },
          UpdateExpression: 'ADD currentAttendeesCount :negOne',
          ExpressionAttributeValues: { ':negOne': -1 },
        }));
      }
      await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: r.PK, SK: r.SK } }));
    }),
    ...classes
      .filter((c) => (c.waitlist ?? []).some((e) => e.member === memberId))
      .map((c) => ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: c.PK, SK: c.SK },
        UpdateExpression: 'SET waitlist = :waitlist',
        ExpressionAttributeValues: { ':waitlist': (c.waitlist ?? []).filter((e) => e.member !== memberId) },
      }))),
  ]);

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));

  return json(200, { success: true });
}
