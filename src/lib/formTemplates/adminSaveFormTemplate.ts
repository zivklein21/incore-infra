import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, formTemplateVersionKey, fromStored, parseBrand } from './shared';
import { defaultRoleFor, normalizeSections, normalizeSigners, normalizeTraineeDevice, templateContentHash, TemplateValidationError } from './schema';

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

// POST /adminSaveFormTemplate
// Body: { id?: string, name: string, signers?: SignerRole[], traineeDevice?: TraineeDevice,
//         sections: TemplateSection[] (v2, or v1),
//         requireResign?: boolean, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Same "edit everything, then Save once"
// model as adminSaveRegistrationFormConfig.ts, but every save whose CONTENT
// (signers + sections, see templateContentHash) changed publishes a new
// immutable version (FORM_TEMPLATE_VERSION#<id>#<n>) — a name-only change
// doesn't. requireResign is recorded on the new version only; nothing reads
// it until per-signer signing exists, and it defaults to false, so editing
// a form never asks anyone to sign again unless the admin explicitly says so.
// Returns { id, version, published } — published=false when nothing but the
// name changed.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; signers?: unknown; traineeDevice?: unknown; sections?: unknown; requireResign?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const brand = parseBrand(body.brand);
  const role = defaultRoleFor(brand);
  const table = tableForBrand(brand);

  let sections;
  try {
    sections = normalizeSections(body.sections, role);
  } catch (err) {
    if (err instanceof TemplateValidationError) return json(400, { error: 'invalid_argument', detail: err.message });
    throw err;
  }
  // INCORE has no separate parent/trainee signing — every field is the member's own.
  const signers = brand === 'forca' ? normalizeSigners(body.signers, role) : [role];
  if (brand !== 'forca') sections = sections.map(s => ({ ...s, fields: s.fields.map(f => ({ ...f, filledBy: role })) }));
  // INCORE has no parent/trainee split, so the setting is meaningless there.
  const traineeDevice = brand === 'forca' ? normalizeTraineeDevice(body.traineeDevice) : normalizeTraineeDevice(undefined);
  const contentHash = templateContentHash({ signers, sections, traineeDevice });

  const now = new Date().toISOString();
  const existingId = typeof body.id === 'string' && body.id ? body.id : '';
  const id = existingId || randomUUID();

  let createdAt = now;
  let previousVersion = 0;
  let previousHash = '';
  const writes: TransactItems = [];
  let headCondition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> } =
    { ConditionExpression: 'attribute_not_exists(SK)' };

  if (existingId) {
    const existing = await ddb.send(new GetCommand({ TableName: table, Key: formTemplateKey(id) }));
    if (!existing.Item) return json(404, { error: 'not_found' });
    const stored = fromStored(existing.Item, brand);
    createdAt = stored.createdAt || now;
    previousVersion = stored.currentVersion;
    previousHash = stored.contentHash;
    if (stored.legacy) {
      // Snapshot the pre-versioning content as V1 before anything replaces it.
      writes.push({ Put: {
        TableName: table,
        Item: {
          ...formTemplateVersionKey(id, 1), templateId: id, version: 1, name: stored.name,
          signers: stored.signers, traineeDevice: stored.traineeDevice, sections: stored.sections, contentHash: stored.contentHash,
          publishedAt: stored.updatedAt || now, publishedBy: 'migration', requireResign: false,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      } });
      headCondition = { ConditionExpression: 'attribute_not_exists(currentVersion)' };
    } else {
      // Optimistic lock — two admins saving at once can't both claim version n+1.
      headCondition = { ConditionExpression: 'currentVersion = :cur', ExpressionAttributeValues: { ':cur': previousVersion } };
    }
  }

  const published = contentHash !== previousHash;
  const version = published ? previousVersion + 1 : previousVersion;
  if (published) {
    writes.push({ Put: {
      TableName: table,
      Item: {
        ...formTemplateVersionKey(id, version), templateId: id, version, name, signers, traineeDevice, sections, contentHash,
        publishedAt: now, publishedBy: uid, requireResign: body.requireResign === true,
      },
      ConditionExpression: 'attribute_not_exists(SK)',
    } });
  }
  writes.push({ Put: {
    TableName: table,
    Item: {
      ...formTemplateKey(id), id, name, schemaVersion: 2, signers, traineeDevice, sections, contentHash,
      currentVersion: version, createdAt, updatedAt: now,
    },
    ...headCondition,
  } });

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return json(409, { error: 'conflict' });
    throw err;
  }

  return json(200, { success: true, id, version, published });
}
