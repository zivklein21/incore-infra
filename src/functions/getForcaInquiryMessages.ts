import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaSupportInquiryItem, ForcaSupportInquiryMessageItem } from '../lib/entities';

// GET or POST /getForcaInquiryMessages?inquiryId=xxx
// Auth: Cognito JWT. Same authorization as sendForcaSupportMessage.ts —
// trainee, her linked parent, admin, or an assigned coach.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const inquiryId = event.queryStringParameters?.inquiryId;
  if (!inquiryId) return json(400, { error: 'missing_inquiry_id' });

  const inquiryRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAINQUIRY#${inquiryId}`, SK: 'METADATA' } }));
  const inquiry = inquiryRes.Item as ForcaSupportInquiryItem | undefined;
  if (!inquiry) return json(404, { error: 'inquiry_not_found' });

  const authorized = inquiry.userId === callerUid
    || (await isAdmin(callerUid))
    || (await verifyFamilyLink(callerUid, inquiry.userId)).ok
    || await (async () => {
      const access = await getCoachAccess(callerUid);
      return !!access && !access.isAdmin && inquiry.recipientRole === 'coach' && groupInAccess(access, inquiry.groupId);
    })();
  if (!authorized) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `FORCAINQUIRY#${inquiryId}`, ':prefix': 'MESSAGE#' },
  }));

  const messages = ((res.Items ?? []) as ForcaSupportInquiryMessageItem[])
    .map((m) => ({
      id: (m.SK as string).replace('MESSAGE#', ''),
      text: m.text ?? '',
      sender: m.sender ?? 'member',
      messageKey: m.messageKey,
      createdAt: m.createdAt,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  return json(200, { messages });
}
