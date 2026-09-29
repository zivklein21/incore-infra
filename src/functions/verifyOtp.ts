import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';

// POST /verifyOtp
// Auth: NONE — see sendOtp.ts; part of the pre-login forgot-password flow.
//
// sendOtp.ts writes the OTP record to whichever of TABLE_NAME/
// FORCA_TABLE_NAME actually holds that email's member profile — this side
// doesn't know which one without checking, so it queries both in parallel
// and uses whichever one has a hit (same fix as sendOtp.ts's own member
// lookup — this used to only ever check TABLE_NAME, so a FORCA member's
// code was written to FORCA_TABLE_NAME but could never be found here).
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

  const query = (tableName: string) => ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: 'code = :code AND #used = :false',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':pk': `OTP#${email}`, ':code': code, ':false': false },
  }));
  const [incoreRes, forcaRes] = await Promise.all([query(TABLE_NAME), query(FORCA_TABLE_NAME)]);

  type OtpItem = { PK: string; SK: string; expiresAt: string; memberId: string };
  const incoreItem = (incoreRes.Items ?? [])[0] as OtpItem | undefined;
  const forcaItem = (forcaRes.Items ?? [])[0] as OtpItem | undefined;
  const otpItem = incoreItem ?? forcaItem;
  if (!otpItem) return json(400, { error: 'Invalid verification code' });
  const tableName = incoreItem ? TABLE_NAME : FORCA_TABLE_NAME;

  if (new Date(otpItem.expiresAt).getTime() < Date.now()) {
    return json(400, { error: 'Verification code has expired' });
  }

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: otpItem.PK, SK: otpItem.SK },
    UpdateExpression: 'SET #used = :true',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':true': true },
  }));

  return json(200, { success: true, memberId: otpItem.memberId });
}
