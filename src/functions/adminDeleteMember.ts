import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /adminDeleteMember
// Body: { memberId, brand? }
// Auth: Cognito JWT, caller must be admin
//
// Permanently removes a member: deletes every still-active registration
// (decrementing the class's attendee count for REGISTERED ones — cancelled
// registrations are already gone from REG# by the time they're cancelled,
// see adminCancelRegistration.ts's Delete), strips them from every class's
// waitlist, then deletes every remaining item under PK=MEMBER#<id> (profile,
// wallet, punch cards, cancellation history, membership history, messages,
// etc.) so no trace of the member is left in the table.
//
// `brand` picks which of the two fully separate tables (TABLE_NAME/
// FORCA_TABLE_NAME — see dynamo.ts) to operate on. This used to always hit
// the INCORE table regardless — deleting a FORCA member found zero
// registrations/member items there (her data was never in that table to
// begin with) and still returned {success:true}, so the delete silently
// no-opped and she kept showing up afterward.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const tableName = tableForBrand(body.brand === 'forca' ? 'forca' : 'incore');

  const [regsRes, classesRes, memberItemsRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#' },
    })),
    ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
    })),
    ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}` },
    })),
  ]);

  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  const classes = (classesRes.Items ?? []) as ClassItem[];
  const memberItems = (memberItemsRes.Items ?? []) as { PK: string; SK: string }[];

  await Promise.all([
    ...registrations.map(async (r) => {
      if (r.status === 'REGISTERED') {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' },
          UpdateExpression: 'ADD currentAttendeesCount :negOne',
          ExpressionAttributeValues: { ':negOne': -1 },
        }));
      }
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { PK: r.PK, SK: r.SK } }));
    }),
    ...classes
      .filter((c) => (c.waitlist ?? []).some((e) => e.member === memberId))
      .map((c) => ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: c.PK, SK: c.SK },
        UpdateExpression: 'SET waitlist = :waitlist',
        ExpressionAttributeValues: { ':waitlist': (c.waitlist ?? []).filter((e) => e.member !== memberId) },
      }))),
  ]);

  await Promise.all(
    memberItems.map((item) => ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { PK: item.PK, SK: item.SK },
    }))),
  );

  return json(200, { success: true });
}
