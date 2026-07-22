import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// POST /updateProfilePhoto
// Auth: Cognito JWT (any signed-in member, own profile only)
// Body: { photoKey: string }
//
// Called right after the client finishes uploading to S3 (getUploadUrl.ts)
// and, best-effort, calling resizeProfilePhoto — persists the S3 object key
// so getProfile.ts can resolve it to a presigned display URL on future
// reads. photoKey must be the caller's own profile_photos/ path (mirrors
// getUploadUrl.ts's ALLOWED_PREFIXES/pathContainsOwnUid check) so a member
// can't point their profile at another member's uploaded photo.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { photoKey?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const photoKey = typeof body.photoKey === 'string' ? body.photoKey.trim() : '';
  if (!photoKey || !photoKey.startsWith('profile_photos/') || !photoKey.includes(uid)) {
    return json(400, { error: 'invalid_photo_key' });
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET photoKey = :photoKey',
    ExpressionAttributeValues: { ':photoKey': photoKey },
  }));

  return json(200, { success: true });
}
