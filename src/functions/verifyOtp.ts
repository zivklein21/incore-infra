import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';

// POST /verifyOtp
// Auth: NONE — see sendOtp.ts; part of the pre-login forgot-password flow.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { email?: unknown; code?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing email or code' });
  }

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !code) return json(400, { error: 'Missing email or code' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: 'code = :code AND #used = :false',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':pk': `OTP#${email}`, ':code': code, ':false': false },
  }));

  const otpItem = (res.Items ?? [])[0] as { PK: string; SK: string; expiresAt: string; memberId: string } | undefined;
  if (!otpItem) return json(400, { error: 'Invalid verification code' });

  if (new Date(otpItem.expiresAt).getTime() < Date.now()) {
    return json(400, { error: 'Verification code has expired' });
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: otpItem.PK, SK: otpItem.SK },
    UpdateExpression: 'SET #used = :true',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':true': true },
  }));

  return json(200, { success: true, memberId: otpItem.memberId });
}
