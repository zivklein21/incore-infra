import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ClassItem } from '../lib/entities';
import { broadcastSpotOpen } from '../lib/waitlistCore';

// POST /rejectWaitlistOffer — member leaves the waitlist.
// SECURITY NOTE: no auth in the original, ported as-is and flagged.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { memberId?: unknown; classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing memberId or classId' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId : '';
  const classId = typeof body.classId === 'string' ? body.classId : '';
  if (!memberId || !classId) return json(400, { error: 'Missing memberId or classId' });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const newWaitlist = (classItem.waitlist ?? []).filter((e) => e.member !== memberId);
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: classKey,
    UpdateExpression: 'SET waitlist = :waitlist',
    ExpressionAttributeValues: { ':waitlist': newWaitlist },
  }));

  // Cascade: offer the spot to the next waiting member.
  await broadcastSpotOpen(classId);

  return json(200, { success: true });
}
