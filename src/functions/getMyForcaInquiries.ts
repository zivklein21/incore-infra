import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaSupportInquiryItem } from '../lib/entities';

// GET or POST /getMyForcaInquiries?childUid=<uid>
// Auth: Cognito JWT — own inquiries, or (family-link-verified) a linked
// daughter's, same Child Switcher convention as getChildOrders.ts. No AWS
// WebSocket transport exists yet — fetched once + polled by the client.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const q = event.queryStringParameters ?? {};
  const childUid = typeof q.childUid === 'string' ? q.childUid.trim() : '';

  let targetUid = callerUid;
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
    targetUid = childUid;
  }

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${targetUid}`, ':prefix': 'FORCAINQUIRY#' },
  }));

  const inquiries = ((res.Items ?? []) as ForcaSupportInquiryItem[])
    .map((i) => ({
      id: i.PK.replace('FORCAINQUIRY#', ''),
      subject: i.subject ?? '',
      status: i.status,
      recipientRole: i.recipientRole,
      groupName: i.groupName ?? null,
      lastMessage: i.lastMessage ?? '',
      lastSender: i.lastSender ?? 'member',
      createdAt: i.createdAt ?? null,
      lastMessageAt: i.lastMessageAt ?? null,
    }))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? '').localeCompare(a.lastMessageAt ?? a.createdAt ?? ''));

  return json(200, { inquiries });
}
