import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, parseBrand } from './shared';
import { listSubmissionsOfTemplate } from './submissions';
import { writeAudit } from './audit';

// POST /adminDeleteFormTemplate
// Body: { id: string, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only.
//
// A template nobody has signed is deleted (its head; published versions
// are kept, they cost nothing and keep history intact). A FORCA template
// with at least one signature is ARCHIVED instead: hidden from families
// (getMyForms.ts lists published only) and from new assignments, while
// every submission, signature and signed PDF stays exactly as it is —
// signed documents are never deleted. Publishing it again un-archives it.
// Returns { result: 'deleted' | 'archived', signedCount }.
//
// The built-in Registration/Orthopedic forms aren't stored under this key
// prefix, so they can't be deleted through here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return json(400, { error: 'missing_id' });
  const brand = parseBrand(body.brand);
  const table = tableForBrand(brand);

  const signedCount = brand === 'forca'
    ? (await listSubmissionsOfTemplate(id)).filter(s => s.signatures.length > 0 || s.acknowledgments.length > 0).length
    : 0;

  if (signedCount > 0) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: formTemplateKey(id),
        UpdateExpression: 'SET #status = :archived, archivedAt = :now, archivedBy = :uid, updatedAt = :now',
        ConditionExpression: 'attribute_exists(SK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':archived': 'archived', ':now': new Date().toISOString(), ':uid': uid },
      }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return json(404, { error: 'not_found' });
      throw err;
    }
    await writeAudit({ action: 'archive', templateId: id, actorUid: uid, detail: { signedCount } });
    return json(200, { success: true, result: 'archived', signedCount });
  }

  await ddb.send(new DeleteCommand({ TableName: table, Key: formTemplateKey(id) }));
  if (brand === 'forca') await writeAudit({ action: 'delete', templateId: id, actorUid: uid });
  return json(200, { success: true, result: 'deleted', signedCount: 0 });
}
