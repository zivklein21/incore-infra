import { createHash, randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { s3 } from '../s3';
import { deriveMemberName } from '../entities';
import { evaluateOutcome } from '../formTemplates/logic';
import { renderFormPdf } from '../formTemplates/pdf/renderFormPdf';
import { brandLogo, signedFormsBucket } from '../formTemplates/signedPdf';
import {
  formsTable, getProfile, getTemplateVersion, listSubmissionsOfChild, listSubmissionsOfTemplate, listTemplateHeads,
  type FormSubmissionItem,
} from '../formTemplates/submissions';
import {
  applyConsentChange, consentPdfContent, consentStatus, currentConsent, isPhotoConsentForm,
  type ConsentDecision, type ConsentRole, type ConsentState, type ConsentStatus,
} from './shared';

// Storage: PK PHOTOCONSENT#<child>, SK STATE (where it stands now) and
// SK LOG#<time>#<id> (one signed record per change, never edited or removed,
// so every earlier version stays in the history). Its own partition keeps
// these signed records out of anything that sweeps a member's items.

const BRAND = 'forca' as const;
const table = () => formsTable(BRAND);
const pk = (childId: string) => `PHOTOCONSENT#${childId}`;
const STATE_SK = 'STATE';

interface StateItem extends ConsentState { updatedAt: string }

export interface ConsentLogItem {
  PK: string; SK: string;
  id: string;
  childId: string;
  role: ConsentRole;
  decision: ConsentDecision;
  statusAfter: ConsentStatus;
  userId: string;
  name: string;
  paths: string[];
  signedAt: string;
  device: 'parent_phone' | 'trainee_phone';
  pdfS3Key?: string;
  pdfSha256?: string;
}

/** The result of a completed sign-up photo form, from the current wording of its outcome. */
async function formResult(sub: FormSubmissionItem, outcome: Parameters<typeof evaluateOutcome>[0]) {
  const t = await getTemplateVersion(BRAND, sub.templateId, sub.version);
  if (!t) return null;
  return { approved: evaluateOutcome(outcome, t.sections, sub.answers)?.approved === true, at: sub.completedAt ?? sub.updatedAt };
}

async function consentFromForms(childId: string) {
  const heads = (await listTemplateHeads(BRAND)).filter(h => isPhotoConsentForm(h.name));
  if (!heads.length) return null;
  const done = (await listSubmissionsOfChild(BRAND, childId))
    .filter(s => s.status === 'completed' && heads.some(h => h.id === s.templateId))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const latest = done[0];
  return latest ? formResult(latest, heads.find(h => h.id === latest.templateId)?.settings.outcome) : null;
}

async function savedState(childId: string): Promise<StateItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: { PK: pk(childId), SK: STATE_SK } }));
  return (res.Item as StateItem | undefined) ?? null;
}

export async function loadConsent(childId: string): Promise<{ state: ConsentState; savedAt: string | null }> {
  const [saved, form] = await Promise.all([savedState(childId), consentFromForms(childId)]);
  return { state: currentConsent(saved, form), savedAt: saved?.updatedAt ?? null };
}

export async function consentHistory(childId: string): Promise<ConsentLogItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :log)',
    ExpressionAttributeValues: { ':pk': pk(childId), ':log': 'LOG#' },
    ScanIndexForward: false,
    Limit: 100,
  }));
  return (res.Items ?? []) as ConsentLogItem[];
}

/** Every trainee's status at once, for the admin and coach lists. A trainee who isn't in the map has no consent. */
export async function allConsentStatuses(): Promise<Map<string, ConsentStatus>> {
  const saved = new Map<string, StateItem>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table(),
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :state',
      ExpressionAttributeValues: { ':prefix': 'PHOTOCONSENT#', ':state': STATE_SK },
      ExclusiveStartKey,
    }));
    for (const item of res.Items ?? []) saved.set(String(item.PK).replace('PHOTOCONSENT#', ''), item as unknown as StateItem);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const forms = new Map<string, { approved: boolean; at: string }>();
  for (const head of (await listTemplateHeads(BRAND)).filter(h => isPhotoConsentForm(h.name))) {
    for (const sub of await listSubmissionsOfTemplate(BRAND, head.id)) {
      if (sub.status !== 'completed') continue;
      const seen = forms.get(sub.childId);
      if (seen && seen.at >= (sub.completedAt ?? sub.updatedAt)) continue;
      const result = await formResult(sub, head.settings.outcome);
      if (result) forms.set(sub.childId, result);
    }
  }

  const out = new Map<string, ConsentStatus>();
  for (const childId of new Set([...saved.keys(), ...forms.keys()])) {
    out.set(childId, consentStatus(currentConsent(saved.get(childId) ?? null, forms.get(childId) ?? null)));
  }
  return out;
}

export class ConsentConflict extends Error {}

/** Records the change and the new state together, so a withdrawal can never be half-applied. */
export async function recordConsentChange(input: {
  childId: string; role: ConsentRole; decision: ConsentDecision; userId: string; name: string; paths: string[];
  device: ConsentLogItem['device'];
}): Promise<{ log: ConsentLogItem; state: ConsentState; status: ConsentStatus }> {
  const { state: before, savedAt } = await loadConsent(input.childId);
  const state = applyConsentChange(before, input.role, input.decision);
  const status = consentStatus(state);
  const now = new Date().toISOString();
  const id = randomUUID();
  const log: ConsentLogItem = {
    PK: pk(input.childId), SK: `LOG#${now}#${id}`, id, childId: input.childId, role: input.role, decision: input.decision,
    statusAfter: status, userId: input.userId, name: input.name, paths: input.paths, signedAt: now, device: input.device,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table(), Item: log } },
        {
          Put: {
            TableName: table(),
            Item: { PK: pk(input.childId), SK: STATE_SK, parent: state.parent, trainee: state.trainee, updatedAt: now },
            ...(savedAt
              ? { ConditionExpression: 'updatedAt = :prev', ExpressionAttributeValues: { ':prev': savedAt } }
              : { ConditionExpression: 'attribute_not_exists(SK)' }),
          },
        },
      ],
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') throw new ConsentConflict();
    throw err;
  }
  return { log, state, status };
}

/** Renders and stores one change's signed PDF. Idempotent — the record keeps the first key. */
export async function ensureConsentPdf(log: ConsentLogItem): Promise<string> {
  if (log.pdfS3Key) return log.pdfS3Key;
  const child = await getProfile(BRAND, log.childId);
  const childName = child ? deriveMemberName(child) : '';
  const generatedAt = new Date();
  const { sections, answers } = consentPdfContent({ role: log.role, decision: log.decision, status: log.statusAfter, childName });
  const bytes = await renderFormPdf({
    title: 'הסכמה לצילום ולפרסום',
    code: 'PHOTO-CONSENT',
    version: 1,
    sections,
    answers,
    signatures: [{ fieldId: 'signature', role: log.role, userId: log.userId, name: log.name, paths: log.paths, signedAt: log.signedAt, device: log.device, version: 1 }],
    submissionId: log.id,
    childName,
    generatedAt,
    brand: BRAND,
    logoPng: await brandLogo(BRAND),
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `signed-forms/${log.childId}/PHOTO-CONSENT/${log.id}.pdf`;
  await s3.send(new PutObjectCommand({
    Bucket: signedFormsBucket(BRAND),
    Key: key,
    Body: bytes,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'aws:kms',
    ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    Metadata: { submission: log.id, sha256 },
  }));
  await ddb.send(new UpdateCommand({
    TableName: table(),
    Key: { PK: log.PK, SK: log.SK },
    UpdateExpression: 'SET pdfS3Key = :k, pdfSha256 = :h',
    ExpressionAttributeValues: { ':k': key, ':h': sha256 },
  }));
  return key;
}
