import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// POST /sendWelcomeEmail
// Body: { to, subject, html }
// Auth: Cognito JWT (any signed-in member)
//
// Queues a PK=MAIL#<id> item — processMail.ts's DynamoDB Streams trigger
// picks it up and sends it via nodemailer, then deletes the item. Replaces
// HealthDeclarationScreen's old direct Firestore `mail` collection write
// (Trigger Email extension), which had gone silently non-functional once
// the app stopped using Firebase Auth.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran

  let body: { to?: unknown; subject?: unknown; html?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject : '';
  const html = typeof body.html === 'string' ? body.html : '';
  if (!to) return json(400, { error: 'missing_to' });

  const id = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: `MAIL#${id}`, SK: 'METADATA', to, message: { subject, html } },
  }));

  return json(200, { success: true });
}
