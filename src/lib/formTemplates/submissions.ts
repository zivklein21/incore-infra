import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getAllMemberProfiles } from '../memberScan';
import { deriveMemberName, type MemberProfileItem } from '../entities';
import { completionStatus } from './completion';
import {
  FORM_ASSIGNMENT_SK_PREFIX, FORM_TEMPLATE_SK_PREFIX, formSubmissionPk, formTemplateKey, formTemplateVersionKey,
  fromStored, fromVersionItem, StoredTemplate,
} from './shared';
import type { SignerRole } from './schema';
import type { Answers } from './logic';
import type { AcknowledgmentRecord, SignatureRecord } from './pdf/renderFormPdf';

// FORCA forms: who a published form is assigned to, and each family's copy
// of it (a "submission"). Shared by the admin endpoints (assign, tracking,
// reminders) and the family ones (getMyForms, submitFormPart).
//
// A submission is created the first time a signer submits their part, on
// the version published at that moment, and stays on that version: a newer
// version only replaces it when the admin published it with "Require
// re-sign" (resignFromVersion) — and even then the old submission, its
// signatures and its PDF are kept untouched; the family just gets a new one.

export const FORCA = 'forca' as const;
export const formsTable = () => tableForBrand(FORCA);

export type AssignmentTarget =
  | { kind: 'all' }
  | { kind: 'group'; groupId: string; groupName?: string }
  | { kind: 'members'; memberIds: string[] };

export interface FormAssignmentItem {
  PK: string; SK: string;
  assignmentId: string;
  templateId: string;
  target: AssignmentTarget;
  /** Answers to the version's admin-filled fields (event name, date, …) — read-only for families. */
  adminAnswers: Answers;
  /** Version the admin answers were filled against. */
  version: number;
  createdAt: string;
  createdBy: string;
  cancelledAt?: string;
}

export type SubmissionStatus = 'pending_parent' | 'pending_child' | 'completed';

export interface FormSubmissionItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  submissionId: string;
  templateId: string;
  assignmentId: string;
  childId: string;
  version: number;
  answers: Answers;
  /** fieldId → role that wrote it (locks 'signer' fields to the first one, and keeps each role's answers its own). */
  answeredBy: Record<string, SignerRole>;
  signatures: SignatureRecord[];
  acknowledgments: AcknowledgmentRecord[];
  signedRoles: SignerRole[];
  ackRoles: SignerRole[];
  status: SubmissionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pdfS3Key?: string;
  pdfSha256?: string;
  pdfGeneratedAt?: string;
}

export function computeSubmissionStatus(input: {
  signers: SignerRole[]; acknowledgers: SignerRole[]; resignFromVersion: number;
  signedRoles: SignerRole[]; ackRoles: SignerRole[]; version: number;
}): { status: SubmissionStatus; missing: SignerRole[] } {
  const records = [
    ...input.signedRoles.map(role => ({ role, kind: 'signature' as const, version: input.version, at: '' })),
    ...input.ackRoles.map(role => ({ role, kind: 'acknowledgment' as const, version: input.version, at: '' })),
  ];
  const c = completionStatus({ signers: input.signers, acknowledgers: input.acknowledgers, resignFromVersion: input.resignFromVersion, records });
  // Acknowledgers only get their turn once every signer has signed.
  const missing = c.missingSignatures.length ? c.missingSignatures : c.missingAcknowledgments;
  if (!missing.length) return { status: 'completed', missing };
  return { status: missing.includes('parent') ? 'pending_parent' : 'pending_child', missing };
}

// ─── Loading ────────────────────────────────────────────────────────────────

export async function getTemplateHead(templateId: string): Promise<(StoredTemplate & { resignFromVersion: number }) | null> {
  const res = await ddb.send(new GetCommand({ TableName: formsTable(), Key: formTemplateKey(templateId) }));
  if (!res.Item) return null;
  return { ...fromStored(res.Item, FORCA), resignFromVersion: typeof res.Item.resignFromVersion === 'number' ? res.Item.resignFromVersion : 0 };
}

const versionCache = new Map<string, StoredTemplate>();
/** A published version — immutable, so cached for the life of the Lambda container. */
export async function getTemplateVersion(templateId: string, version: number): Promise<StoredTemplate | null> {
  const key = `${templateId}#${version}`;
  const cached = versionCache.get(key);
  if (cached) return cached;
  const res = await ddb.send(new GetCommand({ TableName: formsTable(), Key: formTemplateVersionKey(templateId, version) }));
  if (!res.Item) return null;
  const t = fromVersionItem(res.Item, FORCA);
  versionCache.set(key, t);
  return t;
}

async function queryAll(params: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function listTemplateHeads(): Promise<(StoredTemplate & { resignFromVersion: number })[]> {
  const items = await queryAll({
    TableName: formsTable(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'APPCONFIG', ':prefix': FORM_TEMPLATE_SK_PREFIX },
  });
  return items.map(i => ({ ...fromStored(i, FORCA), resignFromVersion: typeof i.resignFromVersion === 'number' ? i.resignFromVersion : 0 })).filter(t => t.id);
}

/** Active (not cancelled) assignments — of one template, or all. */
export async function listAssignments(templateId?: string): Promise<FormAssignmentItem[]> {
  const items = await queryAll({
    TableName: formsTable(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'APPCONFIG', ':prefix': `${FORM_ASSIGNMENT_SK_PREFIX}${templateId ? `${templateId}#` : ''}` },
  });
  return (items as unknown as FormAssignmentItem[]).filter(a => !a.cancelledAt);
}

export async function listSubmissionsOfTemplate(templateId: string): Promise<FormSubmissionItem[]> {
  return (await queryAll({
    TableName: formsTable(),
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': formSubmissionPk(templateId) },
  })) as unknown as FormSubmissionItem[];
}

export async function listSubmissionsOfChild(childId: string): Promise<FormSubmissionItem[]> {
  return (await queryAll({
    TableName: formsTable(),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childId}`, ':prefix': 'FORMSUB#' },
  })) as unknown as FormSubmissionItem[];
}

/** Newest submission per assignment (SKs sort by createdAt within child+assignment). */
export function latestByAssignment(subs: FormSubmissionItem[], childId: string): Map<string, FormSubmissionItem> {
  const out = new Map<string, FormSubmissionItem>();
  for (const s of subs) {
    if (s.childId !== childId) continue;
    const prev = out.get(s.assignmentId);
    if (!prev || s.createdAt > prev.createdAt) out.set(s.assignmentId, s);
  }
  return out;
}

// ─── Families ───────────────────────────────────────────────────────────────

export interface Trainee { uid: string; name: string; groupId?: string; profile: MemberProfileItem }

const isTrainee = (p: MemberProfileItem) =>
  p.identity?.accountType !== 'parent_only' && p.role !== 'admin' && p.identity?.role !== 'admin' && p.identity?.role !== 'coach'
  && p.role !== 'coach';

export async function listForcaTrainees(): Promise<Trainee[]> {
  const profiles = await getAllMemberProfiles(formsTable());
  return profiles.filter(isTrainee).map(p => ({
    uid: p.PK.replace(/^MEMBER#/, ''), name: deriveMemberName(p), groupId: p.identity?.groupId, profile: p,
  }));
}

export function targetIncludes(target: AssignmentTarget, trainee: { uid: string; groupId?: string }): boolean {
  if (target.kind === 'all') return true;
  if (target.kind === 'group') return !!trainee.groupId && trainee.groupId === target.groupId;
  return target.memberIds.includes(trainee.uid);
}

export async function getProfile(uid: string): Promise<MemberProfileItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: formsTable(), Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  return (res.Item as MemberProfileItem | undefined) ?? null;
}

/** The linked parent's uid (FORCA: one parent per child, see familyLinks.ts). */
export async function parentOf(childId: string): Promise<string | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: formsTable(),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childId}`, ':prefix': 'FAMILYOF#' },
    Limit: 5,
  }));
  const link = (res.Items ?? [])[0] as { parentUid?: string } | undefined;
  return link?.parentUid ?? null;
}

/**
 * Which published version a family signs: their existing submission's
 * version (finished or not) unless the admin has since published a version
 * with "Require re-sign" past it — then a NEW submission on the latest.
 */
export function versionToSign(head: { publishedVersion: number; resignFromVersion: number }, existing: FormSubmissionItem | undefined): { version: number; reuse: boolean } {
  if (existing && existing.version >= head.resignFromVersion) return { version: existing.version, reuse: true };
  return { version: head.publishedVersion, reuse: false };
}
