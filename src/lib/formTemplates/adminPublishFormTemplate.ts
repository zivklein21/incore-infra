import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, formTemplateVersionKey, fromStored, parseBrand } from './shared';
import { publishIssues } from './schema';
import { writeAudit } from './audit';

// POST /adminPublishFormTemplate
// Body: { id: string, requireResign?: boolean, expectedUpdatedAt?: string, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Publishes the template's saved draft (the
// head — save first) as the next immutable version, after the publish
// checks (schema.ts publishIssues: a signature block per required signer,
// no empty sections, choice fields with options...) — 400
// { error: 'not_publishable', issues } otherwise.
//
// requireResign: only when the admin explicitly picks it do families who
// signed an older version have to sign again (completion.ts reads the
// latest such version). Default false — publishing never asks anyone to
// sign again by itself. Publishing an archived template un-archives it.
//
// Nothing to publish (draft identical to the published version, and not
// archived) → 200 { published: false }.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; requireResign?: unknown; expectedUpdatedAt?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return json(400, { error: 'missing_id' });
  const brand = parseBrand(body.brand);
  const table = tableForBrand(brand);

  const res = await ddb.send(new GetCommand({ TableName: table, Key: formTemplateKey(id) }));
  if (!res.Item) return json(404, { error: 'not_found' });
  const t = fromStored(res.Item, brand);
  if (t.legacy) return json(409, { error: 'save_first' });
  if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt && body.expectedUpdatedAt !== t.updatedAt) {
    return json(409, { error: 'conflict' });
  }

  const issues = publishIssues({ name: t.name, signers: t.signers, sections: t.sections, visibleOn: t.settings.visibleOn, multiSigner: true });
  if (issues.length) return json(400, { error: 'not_publishable', issues });

  const changed = t.contentHash !== t.publishedHash || t.publishedVersion === 0;
  if (!changed && t.status === 'published') return json(200, { success: true, published: false, version: t.publishedVersion });

  const now = new Date().toISOString();
  // Version numbers continue from the highest ever written (currentVersion), never reuse one.
  const version = changed ? Math.max(t.currentVersion, t.publishedVersion) + 1 : t.publishedVersion;
  const requireResign = changed && body.requireResign === true;

  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [];
  if (changed) {
    writes.push({ Put: {
      TableName: table,
      Item: {
        ...formTemplateVersionKey(id, version), templateId: id, version, name: t.name,
        signers: t.signers, acknowledgers: t.acknowledgers, traineeDevice: t.traineeDevice, sections: t.sections,
        contentHash: t.contentHash, settings: t.settings,
        publishedAt: now, publishedBy: uid, requireResign,
      },
      ConditionExpression: 'attribute_not_exists(SK)',
    } });
  }
  writes.push({ Update: {
    TableName: table,
    Key: formTemplateKey(id),
    UpdateExpression: 'SET #status = :published, publishedVersion = :v, publishedHash = :h, currentVersion = :v, updatedAt = :now'
      + (requireResign ? ', resignFromVersion = :v' : ''),
    ConditionExpression: 'updatedAt = :prev',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':published': 'published', ':v': version, ':h': t.contentHash, ':now': now, ':prev': t.updatedAt },
  } });

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return json(409, { error: 'conflict' });
    throw err;
  }

  await writeAudit(brand, { action: 'publish', templateId: id, actorUid: uid, detail: { version, requireResign, unarchived: t.status === 'archived' } });

  return json(200, { success: true, published: true, version, updatedAt: now });
}
