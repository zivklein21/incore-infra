import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

type FormType = 'registration' | 'health' | 'parentalAuthorization' | 'policies';

// POST /adminOverrideFormStatus
// Body: { memberId: string, brand?: 'incore' | 'forca', formType: FormType, submitted: boolean }
// Auth: Cognito JWT, caller must be admin
//
// Powers the Backoffice Trainee Profile's Forms Status tab "full edit"
// requirement — lets an admin mark any of the four onboarding forms
// submitted/pending directly, bypassing the actual fill-it-out flow, for
// cases where a signature was collected on paper, a submission needs
// correcting, etc. This is a blunt status override (flips the same fields
// computeComplianceFlags reads), not a re-submission — it does not
// regenerate a PDF/signature for health/parental-authorization when
// marking submitted; existing on-file details (if any) are preserved,
// only the submitted timestamp is refreshed so the 2-year health
// declaration validity window restarts from now.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; brand?: unknown; formType?: unknown; submitted?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const formType = body.formType as FormType;
  if (!['registration', 'health', 'parentalAuthorization', 'policies'].includes(formType)) {
    return json(400, { error: 'invalid_form_type' });
  }
  const submitted = body.submitted === true;
  const table = tableForBrand(body.brand === 'forca' ? 'forca' : 'incore');

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const forms = { ...(profile.forms ?? {}) } as Record<string, any>;
  const nowIso = new Date().toISOString();

  if (formType === 'registration') {
    forms.registration_form = submitted;
    if (submitted && !forms.registration_answers) forms.registration_answers = {};
  } else if (formType === 'health') {
    if (submitted) {
      forms.health_declaration = { ...(forms.health_declaration ?? {}), submitted_at: nowIso };
    } else {
      delete forms.health_declaration;
    }
  } else if (formType === 'parentalAuthorization') {
    if (submitted) {
      forms.parental_authorization = { ...(forms.parental_authorization ?? {}), submitted_at: nowIso };
    } else {
      delete forms.parental_authorization;
    }
  } else {
    forms.agreedToPolicies = submitted;
    forms.policiesAcceptedAt = submitted ? nowIso : null;
  }

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  console.log(`[adminOverrideFormStatus] member=${memberId} formType=${formType} submitted=${submitted} by ${callerUid}`);
  return json(200, { success: true });
}
