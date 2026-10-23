import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { stableStringify } from './formTemplates/schema';
import { createHash } from 'crypto';

// Versioning for the single-item form content configs under PK='APPCONFIG'
// (REGISTRATION_FORM_CONFIG, TERMS_OF_SERVICE, FORM_WORDING#<formId>).
// Same idea as custom form templates' versions (formTemplates/shared.ts):
// the head item keeps being the one readers fetch, unchanged in shape apart
// from `version`/`contentHash`/`updatedAt`/`updatedBy`; every save whose
// content actually changed also writes an immutable `<SK>_VERSION#000n`
// copy. Readers (getRegistrationFormConfig.ts etc.) never look at versions
// — this only records what members saw when, and never asks anyone to fill
// anything again.
//
// A head saved before versioning existed (no `version`) gets its current
// content snapshotted as version 1 first, so the history starts from what
// members actually saw, not from the first edit.

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

export const configVersionSk = (sk: string, version: number) => `${sk}_VERSION#${String(version).padStart(4, '0')}`;

export const contentHashOf = (content: Record<string, unknown>) =>
  createHash('sha256').update(stableStringify(content)).digest('hex');

/**
 * Writes `content` (the item's own fields, e.g. { sections }) to the head at
 * PK='APPCONFIG' SK=`sk`, publishing a new version when it changed.
 * `contentKeys` names which head fields make up the content (for the V1
 * snapshot of a pre-versioning head). Returns the head's version after the save.
 */
export async function saveVersionedConfig(params: {
  table: string;
  sk: string;
  content: Record<string, unknown>;
  contentKeys: string[];
  uid: string;
}): Promise<{ version: number; published: boolean }> {
  const { table, sk, content, contentKeys, uid } = params;
  const key = { PK: 'APPCONFIG', SK: sk };
  const existing = (await ddb.send(new GetCommand({ TableName: table, Key: key }))).Item;
  const now = new Date().toISOString();
  const hash = contentHashOf(content);
  const writes: TransactItems = [];

  let previousVersion = 0;
  let previousHash = '';
  let headCondition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> } =
    { ConditionExpression: 'attribute_not_exists(SK)' };

  if (existing) {
    if (typeof existing.version === 'number') {
      previousVersion = existing.version;
      previousHash = String(existing.contentHash ?? '');
      headCondition = { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': previousVersion } };
    } else {
      const legacyContent = Object.fromEntries(contentKeys.filter(k => existing[k] !== undefined).map(k => [k, existing[k]]));
      previousVersion = 1;
      previousHash = contentHashOf(legacyContent);
      writes.push({ Put: {
        TableName: table,
        Item: { PK: 'APPCONFIG', SK: configVersionSk(sk, 1), version: 1, ...legacyContent, contentHash: previousHash, publishedAt: String(existing.updatedAt ?? now), publishedBy: 'migration' },
        ConditionExpression: 'attribute_not_exists(SK)',
      } });
      headCondition = { ConditionExpression: 'attribute_not_exists(version)' };
    }
  }

  const published = hash !== previousHash;
  const version = published ? previousVersion + 1 : previousVersion;
  if (published) {
    writes.push({ Put: {
      TableName: table,
      Item: { PK: 'APPCONFIG', SK: configVersionSk(sk, version), version, ...content, contentHash: hash, publishedAt: now, publishedBy: uid },
      ConditionExpression: 'attribute_not_exists(SK)',
    } });
  }
  writes.push({ Put: {
    TableName: table,
    Item: { ...key, ...content, version, contentHash: hash, updatedAt: now, updatedBy: uid },
    ...headCondition,
  } });

  await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  return { version, published };
}

export const isConflict = (err: unknown) => (err as { name?: string })?.name === 'TransactionCanceledException';
