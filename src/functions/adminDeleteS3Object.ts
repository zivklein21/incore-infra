import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteS3Object
// Auth: Cognito JWT, caller must be admin
// Body: { key: string }
// The FE shows a confirmation modal before calling this — S3 delete has no
// undo (bucket has no versioning enabled, see s3.tf).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { key?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return json(400, { error: 'missing_key' });

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));

  return json(200, { success: true });
}
