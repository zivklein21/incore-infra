import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET or POST /adminCheckEmailAvailable?email=xxx
// Auth: Cognito JWT, caller must be admin
// Uses GSI3 (GSI3PK=EMAIL#<email>) — the same index the pre-login OTP flow
// (otp.ts) already relies on for email lookups.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const email = (event.queryStringParameters?.email ?? '').trim().toLowerCase();
  if (!email) return json(400, { error: 'missing_email' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMAIL#${email}` },
    Limit: 1,
  }));

  return json(200, { taken: (res.Items ?? []).length > 0 });
}
