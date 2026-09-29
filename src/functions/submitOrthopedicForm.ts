import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { notifyAdmins } from '../lib/adminNotify';

interface OrthopedicFormQuestion { id: string; text: string; type: string }
interface OrthopedicFormSection { questions?: OrthopedicFormQuestion[] }

// "כן" is the admin's own free-text option choice (options: string[] — see
// FormQuestion in types.ts), not a fixed enum this form controls, so this
// is a convention match (trimmed exact/prefix), not a guaranteed one — same
// caveat as any admin-authored-options form. Good enough for "worth an
// admin's attention", which is all this alert claims to be.
function looksLikeYes(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === 'כן' || value.trim().startsWith('כן ') || value.trim().startsWith('כן,');
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && looksLikeYes(v));
  return false;
}

// Best-effort: resolves each answered question's own text (for a readable
// alert) by reading back the same ORTHOPEDIC_FORM_CONFIG getOrthopedicFormConfig.ts
// serves — this form is FORCA-only, so always FORCA_TABLE_NAME (see
// tableForBrand). Never throws — a missing/malformed config just means a
// less specific alert, not a failed submission.
async function findFlaggedQuestionTexts(answers: Record<string, unknown>): Promise<string[]> {
  try {
    const configRes = await ddb.send(new GetCommand({
      TableName: tableForBrand('forca'),
      Key: { PK: 'APPCONFIG', SK: 'ORTHOPEDIC_FORM_CONFIG' },
    }));
    const sections = Array.isArray(configRes.Item?.sections) ? configRes.Item.sections as OrthopedicFormSection[] : [];
    const questions = sections.flatMap((s) => s.questions ?? []);
    return questions
      .filter((q) => looksLikeYes(answers[q.id]))
      .map((q) => q.text);
  } catch (err) {
    console.error('[submitOrthopedicForm] failed to resolve flagged question text', err);
    return [];
  }
}

// POST /submitOrthopedicForm
// Auth: Cognito JWT (any signed-in member, or a parent switched into her
// child's session via switchProfile.ts — same as submitRegistrationForm.ts/
// submitParentalAuthorization.ts)
// Body: { answers: Record<string, unknown>, traineeName: string, parentName: string,
//         signaturePaths: string[], signatureKey?: string }
//
// Mandatory onboarding step (Registration -> Health -> Orthopedic ->
// Parental Authorization -> Policies — see resolvePostLoginRoute.ts and
// entities.ts's admin.require_orthopedic_form/computeComplianceFlags) — NOT
// gated behind forms.orthopedic_form_requested, which is a separate,
// secondary "flag an already-onboarded trainee for re-submission" mechanism
// (see adminSetOrthopedicFormRequested.ts) that this submit still clears if
// it happens to be set, same auto-clear idiom saveMedicalClearance.ts uses
// for its own requested flag. The declaration block (trainee/parent name +
// digital signature) is required every time, same as
// submitParentalAuthorization.ts's own validation.
//
// Reads forms first and writes the whole map back (SET forms = :merged)
// rather than a nested-path update — DynamoDB rejects that when the parent
// map attribute doesn't exist yet.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { answers?: unknown; traineeName?: unknown; parentName?: unknown; signaturePaths?: unknown; signatureKey?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
  const traineeName = typeof body.traineeName === 'string' ? body.traineeName.trim() : '';
  const parentName = typeof body.parentName === 'string' ? body.parentName.trim() : '';
  const signaturePaths = Array.isArray(body.signaturePaths) ? body.signaturePaths.filter((p): p is string => typeof p === 'string') : [];
  const signatureKey = typeof body.signatureKey === 'string' ? body.signatureKey : undefined;

  if (!traineeName || !parentName || signaturePaths.length === 0) {
    return json(400, { error: 'missing_fields' });
  }

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.orthopedic_form = true;
  forms.orthopedic_answers = answers;
  forms.orthopedic_submitted_at = new Date().toISOString();
  forms.orthopedic_trainee_name = traineeName;
  forms.orthopedic_parent_name = parentName;
  forms.orthopedic_signature_paths = signaturePaths;
  if (signatureKey) forms.orthopedic_signature_key = signatureKey;
  delete forms.orthopedic_form_requested;
  delete forms.orthopedic_form_requested_at;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  // A "כן" answer here is informational, not a gate — this deliberately
  // never touches medicalClearance/medicalConditionChanged (the actual
  // attendance-blocking mechanisms, see reportMedicalConditionChange.ts/
  // adminClearMedicalCondition.ts). Her medical status stays exactly as it
  // was; an admin who reviews this alert decides for herself whether to
  // request medical clearance separately (adminSetMedicalClearanceRequested.ts)
  // — nothing here does that automatically. Fire-and-forget: a notification
  // failure must never fail a form submission that already saved correctly.
  const flaggedQuestions = await findFlaggedQuestionTexts(answers as Record<string, unknown>);
  if (flaggedQuestions.length > 0) {
    await notifyAdmins({
      type: 'ORTHOPEDIC_FORM_FLAGGED',
      priority: 'HIGH',
      brand: 'forca',
      pushTitle: `שאלון רפואי-אורתופדי — ${traineeName}`,
      message: `${traineeName} (הורה: ${parentName}) ענתה "כן" על: ${flaggedQuestions.join(', ')}. הסטטוס הרפואי שלה לא נחסם אוטומטית — נדרש בדיקה ואישור של הצוות.`,
      extra: { memberId: uid, traineeName, parentName, flaggedQuestions },
      pushData: { screen: 'MemberDetails', memberId: uid },
    }).catch((err) => console.error('[submitOrthopedicForm] failed to notify admins', err));
  }

  return json(200, { success: true });
}
