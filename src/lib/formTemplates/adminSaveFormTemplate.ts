import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, formTemplateVersionKey, fromStored, parseBrand } from './shared';
import {
  defaultRoleFor, normalizeAcknowledgers, normalizeSections, isCoachForm, normalizeSettings, normalizeSigners, normalizeTraineeDevice,
  templateContentHash, TemplateValidationError, traineeDeviceFor,
} from './schema';

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

// POST /adminSaveFormTemplate
// Body: { id?: string, name: string, signers?: SignerRole[], acknowledgers?: SignerRole[], traineeDevice?: TraineeDevice,
//         sections: TemplateSection[] (v2, or v1), settings?: TemplateSettings,
//         expectedUpdatedAt?: string, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Saves the DRAFT (the head) — nothing a
// family signs changes until adminPublishFormTemplate.ts publishes it as
// the next version. A brand-new template starts as status 'draft'.
//
// FORCA picks "visible on" (settings.visibleOn), which decides where the
// trainee signs (traineeDevice) — traineeDevice is still stored, since the
// content hash and older app builds read it.
//
// expectedUpdatedAt (the head's updatedAt the editor loaded) makes two
// admins saving the same template at once a 409 instead of a silent
// overwrite. Returns { id, status, version, hasUnpublishedChanges, updatedAt }.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; name?: unknown; signers?: unknown; acknowledgers?: unknown; traineeDevice?: unknown;
    sections?: unknown; settings?: unknown; expectedUpdatedAt?: unknown; brand?: unknown;
  };
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
  // Same system for both brands (INCORE: forms for new members — a minor's
  // parent signs on the member's own device, see familyForms.rolesOnDevice).
  const rawSettings = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as Record<string, unknown>;
  const settings = normalizeSettings(rawSettings, normalizeTraineeDevice(body.traineeDevice));
  // A coach form has exactly one participant: the coach (role 'trainee', see TemplateSettings.audience).
  const coachForm = isCoachForm(settings);
  const signers = coachForm ? ['trainee' as const] : normalizeSigners(body.signers, role);
  const traineeDevice = traineeDeviceFor(settings.visibleOn);
  const acknowledgers = coachForm ? [] : normalizeAcknowledgers(body.acknowledgers, signers);
  const contentHash = templateContentHash({ signers, sections, traineeDevice, acknowledgers });

  const now = new Date().toISOString();
  const existingId = typeof body.id === 'string' && body.id ? body.id : '';
  const id = existingId || randomUUID();

  let createdAt = now;
  let currentVersion = 0;
  let status: 'draft' | 'published' | 'archived' = 'draft';
  let publishedVersion = 0;
  let publishedHash = '';
  const writes: TransactItems = [];
  let headCondition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> } =
    { ConditionExpression: 'attribute_not_exists(SK)' };

  if (existingId) {
    const existing = await ddb.send(new GetCommand({ TableName: table, Key: formTemplateKey(id) }));
    if (!existing.Item) return json(404, { error: 'not_found' });
    const stored = fromStored(existing.Item, brand);
    createdAt = stored.createdAt || now;
    currentVersion = stored.currentVersion;
    status = stored.status;
    publishedVersion = stored.publishedVersion;
    publishedHash = stored.publishedHash;
    if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt && stored.updatedAt && body.expectedUpdatedAt !== stored.updatedAt) {
      return json(409, { error: 'conflict' });
    }
    if (stored.legacy) {
      // Snapshot the pre-versioning content as V1 before anything replaces it.
      writes.push({ Put: {
        TableName: table,
        Item: {
          ...formTemplateVersionKey(id, 1), templateId: id, version: 1, name: stored.name,
          signers: stored.signers, acknowledgers: stored.acknowledgers, traineeDevice: stored.traineeDevice, sections: stored.sections, contentHash: stored.contentHash,
          settings: stored.settings, publishedAt: stored.updatedAt || now, publishedBy: 'migration', requireResign: false,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      } });
      headCondition = { ConditionExpression: 'attribute_not_exists(currentVersion)' };
    } else {
      // Optimistic lock against a concurrent save/publish landing between our read and write.
      headCondition = stored.updatedAt
        ? { ConditionExpression: 'updatedAt = :prev', ExpressionAttributeValues: { ':prev': stored.updatedAt } }
        : { ConditionExpression: 'attribute_exists(SK)' };
    }
  }

  writes.push({ Put: {
    TableName: table,
    Item: {
      ...formTemplateKey(id), id, name, schemaVersion: 2, signers, acknowledgers, traineeDevice, sections, contentHash, settings,
      status, publishedVersion, publishedHash,
      currentVersion, createdAt, updatedAt: now, updatedBy: uid,
    },
    ...headCondition,
  } });

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return json(409, { error: 'conflict' });
    throw err;
  }


  return json(200, { success: true, id, status, version: publishedVersion, hasUnpublishedChanges: contentHash !== publishedHash, updatedAt: now });
}
