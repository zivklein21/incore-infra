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

// Forms (FORCA and INCORE): who a published form is assigned to, and each
// member's / family's copy of it (a "submission"). Shared by the admin
// endpoints (assign, tracking, reminders) and the family ones (getMyForms,
// submitFormPart). Everything lives in the brand's own table.
//
// A submission is created the first time a signer submits their part, on
// the version published at that moment, and stays on that version: a newer
// version only replaces it when the admin published it with "Require
// re-sign" (resignFromVersion) — and even then the old submission, its
// signatures and its PDF are kept untouched; the family just gets a new one.

export type Brand = 'incore' | 'forca';
export const formsTable = (brand: Brand) => tableForBrand(brand);

/**
 * Who sees an assigned form. 'new_members' = only members whose account is
 * created AFTER the assignment (INCORE's "new members only" — existing
 * members are never asked; a profile without createdAt, i.e. a migrated
 * one, counts as existing).
 */
export type AssignmentTarget =
  | { kind: 'all' }
  | { kind: 'new_members' }
  | { kind: 'group'; groupId: string; groupName?: string }
  | { kind: 'members'; memberIds: string[] }
  /** An activity in the calendar: everyone registered to it (the roster at the time it's checked). */
  | { kind: 'activity'; classId: string; className?: string; date: string };

/** The id of a sign-up form's own assignment (one per template; created on publish — see adminPublishFormTemplate.ts). */
export const SIGNUP_ASSIGNMENT_ID = 'signup';

export type Rosters = Map<string, Set<string>>;

/** Registered members of each activity the assignments point at. */
export async function loadRosters(brand: Brand, assignments: { target: AssignmentTarget }[]): Promise<Rosters> {
  const out: Rosters = new Map();
  const classIds = [...new Set(assignments.flatMap(a => (a.target.kind === 'activity' ? [a.target.classId] : [])))];
  await Promise.all(classIds.map(async classId => {
    const items = await queryAll({
      TableName: formsTable(brand),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    });
    out.set(classId, new Set(items.map(i => String(i.userId ?? String(i.SK).replace(/^REG#/, '')))));
  }));
  return out;
}

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
  brand?: Brand;
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

export async function getTemplateHead(brand: Brand, templateId: string): Promise<(StoredTemplate & { resignFromVersion: number }) | null> {
  const res = await ddb.send(new GetCommand({ TableName: formsTable(brand), Key: formTemplateKey(templateId) }));
  if (!res.Item) return null;
  return { ...fromStored(res.Item, brand), resignFromVersion: typeof res.Item.resignFromVersion === 'number' ? res.Item.resignFromVersion : 0 };
}

const versionCache = new Map<string, StoredTemplate>();
/** A published version — immutable, so cached for the life of the Lambda container. */
export async function getTemplateVersion(brand: Brand, templateId: string, version: number): Promise<StoredTemplate | null> {
  const key = `${brand}#${templateId}#${version}`;
  const cached = versionCache.get(key);
  if (cached) return cached;
  const res = await ddb.send(new GetCommand({ TableName: formsTable(brand), Key: formTemplateVersionKey(templateId, version) }));
  if (!res.Item) return null;
  const t = fromVersionItem(res.Item, brand);
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

export async function listTemplateHeads(brand: Brand): Promise<(StoredTemplate & { resignFromVersion: number })[]> {
  const items = await queryAll({
    TableName: formsTable(brand),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'APPCONFIG', ':prefix': FORM_TEMPLATE_SK_PREFIX },
  });
  return items.map(i => ({ ...fromStored(i, brand), resignFromVersion: typeof i.resignFromVersion === 'number' ? i.resignFromVersion : 0 })).filter(t => t.id);
}

/** Active (not cancelled) assignments — of one template, or all. */
export async function listAssignments(brand: Brand, templateId?: string): Promise<FormAssignmentItem[]> {
  const items = await queryAll({
    TableName: formsTable(brand),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'APPCONFIG', ':prefix': `${FORM_ASSIGNMENT_SK_PREFIX}${templateId ? `${templateId}#` : ''}` },
  });
  return (items as unknown as FormAssignmentItem[]).filter(a => !a.cancelledAt);
}

export async function listSubmissionsOfTemplate(brand: Brand, templateId: string): Promise<FormSubmissionItem[]> {
  return (await queryAll({
    TableName: formsTable(brand),
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': formSubmissionPk(templateId) },
  })) as unknown as FormSubmissionItem[];
}

export async function listSubmissionsOfChild(brand: Brand, childId: string): Promise<FormSubmissionItem[]> {
  return (await queryAll({
    TableName: formsTable(brand),
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

export interface Trainee { uid: string; name: string; groupId?: string; createdAt?: string; profile: MemberProfileItem }

const isTrainee = (p: MemberProfileItem) =>
  p.identity?.accountType !== 'parent_only' && p.role !== 'admin' && p.identity?.role !== 'admin' && p.identity?.role !== 'coach'
  && p.role !== 'coach';

const createdAtOf = (p: MemberProfileItem) => {
  const v = (p as { createdAt?: unknown }).createdAt;
  return typeof v === 'string' ? v : undefined;
};

/** The brand's members who can be assigned forms — FORCA trainees / INCORE members (no parent-only accounts, admins or coaches). */
export async function listTrainees(brand: Brand): Promise<Trainee[]> {
  const profiles = await getAllMemberProfiles(formsTable(brand));
  return profiles
    .filter(p => isTrainee(p) && (brand === 'forca' || p.identity?.brand !== 'forca'))
    .map(p => ({ uid: p.PK.replace(/^MEMBER#/, ''), name: deriveMemberName(p), groupId: p.identity?.groupId, createdAt: createdAtOf(p), profile: p }));
}

const isCoach = (p: MemberProfileItem) => p.identity?.role === 'coach' || p.role === 'coach';

/** FORCA coaches — the people a coach form (settings.audience 'coaches') goes to. */
export async function listCoaches(brand: Brand): Promise<Trainee[]> {
  const profiles = await getAllMemberProfiles(formsTable(brand));
  return profiles
    .filter(p => isCoach(p) && p.identity?.accountType !== 'parent_only')
    .map(p => ({ uid: p.PK.replace(/^MEMBER#/, ''), name: deriveMemberName(p), createdAt: createdAtOf(p), profile: p }));
}

/** Who a template's assignments can reach: coaches for a coach form, trainees otherwise. */
export const listFormPeople = (brand: Brand, settings: { audience?: string } | undefined) =>
  (settings?.audience === 'coaches' ? listCoaches(brand) : listTrainees(brand));

export const isCoachProfile = isCoach;

/** `assignedAt` is the assignment's createdAt — needed for 'new_members'. */
export function targetIncludes(
  target: AssignmentTarget, trainee: { uid: string; groupId?: string; createdAt?: string }, assignedAt = '', rosters?: Rosters,
): boolean {
  if (target.kind === 'all') return true;
  if (target.kind === 'activity') return !!rosters?.get(target.classId)?.has(trainee.uid);
  if (target.kind === 'new_members') return !!trainee.createdAt && !!assignedAt && trainee.createdAt > assignedAt;
  if (target.kind === 'group') return !!trainee.groupId && trainee.groupId === target.groupId;
  return target.memberIds.includes(trainee.uid);
}

export async function getProfile(brand: Brand, uid: string): Promise<MemberProfileItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: formsTable(brand), Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  return (res.Item as MemberProfileItem | undefined) ?? null;
}

/** The linked parent's uid (one parent per child, see familyLinks.ts). INCORE members usually have none. */
export async function parentOf(brand: Brand, childId: string): Promise<string | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: formsTable(brand),
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
