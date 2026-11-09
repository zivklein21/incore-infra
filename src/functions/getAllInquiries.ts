import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { SupportInquiryItem } from '../lib/entities';

// GET or POST /getAllInquiries
// Auth: Cognito JWT, caller must be admin
// Full Scan — same documented <=50-user-scale tradeoff as other admin list
// endpoints (getAllMembers.ts, getClasses.ts). No AWS WebSocket transport
// exists yet, so the client polls this instead of the old Firestore
// onSnapshot listener.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  // ?openCount=1 — the admin tab bar's support badge (app 1.5.2+): just the
  // number of open inquiries waiting on an admin reply, instead of every
  // inquiry. Still a Scan (INCORE inquiries have no index yet; DynamoDB
  // bills a Scan by data read even with Select COUNT), but it returns one
  // number and follows every page, so the badge no longer misses inquiries
  // past the first 1 MB. The index-based fix is phase 2 of the history-
  // paging work.
  const openCountParam = event.queryStringParameters?.openCount;
  if (openCountParam === '1' || openCountParam === 'true') {
    let openCount = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        Select: 'COUNT',
        FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND #status = :open AND (attribute_not_exists(lastSender) OR lastSender = :member)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':prefix': 'INQUIRY#', ':metadata': 'METADATA', ':open': 'OPEN', ':member': 'member' },
        ExclusiveStartKey: lastKey,
      }));
      openCount += page.Count ?? 0;
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return json(200, { openCount });
  }

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'INQUIRY#', ':metadata': 'METADATA' },
  }));

  const inquiries = ((res.Items ?? []) as SupportInquiryItem[])
    .map((i) => ({
      id: i.PK.replace('INQUIRY#', ''),
      userId: i.userId ?? '',
      userDisplayName: i.userDisplayName ?? '',
      userEmail: i.userEmail ?? '',
      subject: i.subject ?? '',
      status: i.status,
      lastMessage: i.lastMessage ?? '',
      lastSender: i.lastSender ?? 'member',
      createdAt: i.createdAt ?? null,
      lastMessageAt: i.lastMessageAt ?? null,
    }))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? '').localeCompare(a.lastMessageAt ?? a.createdAt ?? ''));

  return json(200, { inquiries });
}
