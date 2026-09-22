import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ExtraTrainingItem } from '../lib/entities';

// POST /adminDeleteExtraTraining
// Body: { id: string }
// Auth: Cognito JWT, caller must be admin. FORCA-only.
// Deletes the DynamoDB item and its S3 file together — no versioning on the
// bucket, so this is a real, non-recoverable delete either way.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  const key = { PK: `EXTRATRAINING#${id}`, SK: 'METADATA' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const item = res.Item as ExtraTrainingItem | undefined;
  if (!item) return json(404, { error: 'not_found' });

  await Promise.all([
    ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: key })),
    item.fileKey ? s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: item.fileKey })).catch(() => {}) : Promise.resolve(),
  ]);

  return json(200, { success: true });
}
