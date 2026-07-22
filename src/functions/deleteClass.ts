import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /deleteClass
// Auth: Cognito JWT, caller must be admin
// Body: { classId: string }
//
// Deletes only the class's own METADATA item — existing registrations under
// CLASS#<id>/REG#<uid> are left as-is (same as the original Firestore
// deleteClass, which never cleaned up the registrations subcollection
// either; those become orphaned but harmless once the class doc is gone).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
  }));

  return json(200, { success: true });
}
