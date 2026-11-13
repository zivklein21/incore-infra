import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from './auth';
import { getCoachAccess, sessionInAccess } from './coachAccess';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import { deriveMemberName, type ClassItem, type MemberProfileItem, type RegistrationItem } from './entities';
import { verifyFamilyLink } from './familyLinks';
import { getProfile, parentOf } from './formTemplates/submissions';
import { getUid, json } from './http';

// FORCA quick dial: who can call whom. Both handlers ride incoreWorkoutApi.ts's
// shared integration (300-integration cap).

export interface PhoneContact {
  name: string;
  phone: string;
}

export const EMERGENCY_NAME_MAX = 80;

// Spaces, dashes, brackets, and the invisible direction marks a number picks
// up when it's copied out of a Hebrew contact card.
const PHONE_NOISE = /[\s\-().‎‏‪-‮⁦-⁩]/g;

export function normalizePhone(raw: string): string | null {
  const phone = raw.replace(PHONE_NOISE, '');
  return /^\+?\d{7,15}$/.test(phone) ? phone : null;
}

export type ParsedEmergencyContact =
  | { ok: true; contact: PhoneContact | null }
  | { ok: false; error: 'invalid_name' | 'invalid_phone' };

/** `null`, or a blank name and phone, means "clear it". Otherwise both are required. */
export function parseEmergencyContact(raw: unknown): ParsedEmergencyContact {
  if (raw === null) return { ok: true, contact: null };
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_name' };
  const { name: rawName, phone: rawPhone } = raw as { name?: unknown; phone?: unknown };
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const phone = typeof rawPhone === 'string' ? rawPhone.trim() : '';
  if (!name && !phone) return { ok: true, contact: null };
  if (!name || name.length > EMERGENCY_NAME_MAX) return { ok: false, error: 'invalid_name' };
  const normalized = normalizePhone(phone);
  if (!normalized) return { ok: false, error: 'invalid_phone' };
  return { ok: true, contact: { name, phone: normalized } };
}

function memberPhone(profile: MemberProfileItem | null | undefined): string {
  return (profile?.identity?.phone ?? profile?.phone ?? '').trim();
}

/** The trainee's linked parent, or null when there's no parent or no number on file. */
export async function parentContactOf(traineeUid: string): Promise<PhoneContact | null> {
  const parentUid = await parentOf('forca', traineeUid);
  if (!parentUid) return null;
  const parent = await getProfile('forca', parentUid);
  const phone = memberPhone(parent);
  return parent && phone ? { name: deriveMemberName(parent), phone } : null;
}

// POST /saveEmergencyContact
// Body: { memberId: string, contact: { name, phone } | null }
// Auth: Cognito JWT — admin, or the trainee's linked parent. The trainee
// can't edit it herself.
export async function saveEmergencyContact(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { memberId?: unknown; contact?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const [admin, link] = await Promise.all([isAdmin(callerUid), verifyFamilyLink(callerUid, memberId)]);
  if (!admin && !link.ok) return json(403, { error: 'forbidden' });

  const parsed = parseEmergencyContact(body.contact);
  if (!parsed.ok) return json(400, { error: parsed.error });

  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      ConditionExpression: 'attribute_exists(PK)',
      ...(parsed.contact
        ? { UpdateExpression: 'SET emergencyContact = :contact', ExpressionAttributeValues: { ':contact': parsed.contact } }
        : { UpdateExpression: 'REMOVE emergencyContact' }),
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return json(404, { error: 'member_not_found' });
    throw err;
  }

  return json(200, { emergencyContact: parsed.contact });
}

// GET /getSessionContacts?classId=xxx
// Auth: Cognito JWT — staff only. Numbers go to an admin or the coach who runs
// this session (same attendance gate as getCoachSessions.ts, same
// sessionInAccess() ownership check), and only for trainees on its roster. Any
// other coach gets an empty result rather than a 403: the app then just shows
// no call button.
//
// Separate from the roster itself so phone numbers aren't sent with every
// getCoachSessions.ts / getTrainingHistory.ts response. Keyed by memberId;
// a number that doesn't exist is null.
export async function getSessionContacts(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  const classId = event.queryStringParameters?.classId?.trim();
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (access.permissions.attendance === 'none' || !sessionInAccess(access, session, callerUid)) return json(200, { contacts: {} });

  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const memberIds = ((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId);

  const entries = await Promise.all(memberIds.map(async (memberId) => {
    const [profile, parent] = await Promise.all([getProfile('forca', memberId), parentContactOf(memberId)]);
    return [memberId, {
      phone: memberPhone(profile) || null,
      parent,
      emergency: profile?.emergencyContact ?? null,
    }] as const;
  }));

  return json(200, { contacts: Object.fromEntries(entries) });
}
