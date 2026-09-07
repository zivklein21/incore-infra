import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminUnlinkFamilyMember
// Auth: Cognito JWT, caller must be admin
// Body: { parentUid: string, childUid: string }
//
// Deleting the single FamilyLinkItem removes both the forward (parent's
// partition) and GSI1 (reverse, child-side) lookups in one write — GSI1 is a
// projection of this item, not a second item.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { parentUid?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const parentUid = typeof body.parentUid === 'string' ? body.parentUid.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!parentUid || !childUid) return json(400, { error: 'missing_required_fields' });

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${parentUid}`, SK: `FAMILY#${childUid}` } }));

  return json(200, { success: true });
}
