import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// POST /updateProfile
// Auth: Cognito JWT (any signed-in member, own profile only)
// Body: { name, email, phone }
//
// Replaces ProfileScreen's old Firestore updateDoc('identity.name'/etc.)
// call. Writes the plain top-level name/email/phone fields — getProfile.ts
// already prefers identity.* but falls back to these, so this stays
// readable without needing to also maintain the legacy identity.* shape.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { name?: unknown; email?: unknown; phone?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!name || !email || !phone) {
    return json(400, { error: 'missing_fields', required: ['name', 'email', 'phone'] });
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET #name = :name, email = :email, phone = :phone',
    ExpressionAttributeNames: { '#name': 'name' },
    ExpressionAttributeValues: { ':name': name, ':email': email, ':phone': phone },
  }));

  return json(200, { success: true });
}
