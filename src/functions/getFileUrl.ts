import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET or POST /getFileUrl?storagePath=xxx
// Auth: Cognito JWT. Caller must own the path (it contains their own uid,
// same convention getUploadUrl.ts enforces on write) or be admin — admins
// need to view members' health declarations / doctor approvals
// (MemberDetailsScreen.tsx), members only ever need their own files.
const DOWNLOAD_URL_EXPIRY_SECONDS = 900;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let bodyPath = '';
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { storagePath?: unknown };
      bodyPath = typeof body.storagePath === 'string' ? body.storagePath : '';
    } catch { /* fall through to query-param lookup */ }
  }
  const storagePath = event.queryStringParameters?.storagePath ?? bodyPath;
  if (!storagePath) return json(400, { error: 'missing_storage_path' });

  if (!storagePath.includes(callerUid) && !(await isAdmin(callerUid))) {
    return json(403, { error: 'forbidden' });
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath }),
    { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS },
  );

  return json(200, { url });
}
