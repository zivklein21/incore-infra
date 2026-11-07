import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

const FILE_URL_EXPIRY_SECONDS = 900;

// GET or POST /getTraineeOrthopedicForm?memberId=...
// Auth: Cognito JWT, admin only. A coach gets the trainee's medical alert
// instead, never these answers or the signed form (lib/medicalAlert.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId
    ?? (event.body ? (JSON.parse(event.body) as { memberId?: unknown }).memberId : undefined);
  if (typeof memberId !== 'string' || !memberId) return json(400, { error: 'missing_member_id' });

  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const forms = profile.forms ?? {};
  const signatureKey = forms.orthopedic_signature_key;
  const pdfUrl = signatureKey
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: signatureKey }), { expiresIn: FILE_URL_EXPIRY_SECONDS }).catch(() => null)
    : null;

  return json(200, {
    orthopedicForm: forms.orthopedic_form === true,
    answers: forms.orthopedic_answers ?? null,
    declaration: forms.orthopedic_submitted_at
      ? {
          submittedAt: forms.orthopedic_submitted_at,
          traineeName: forms.orthopedic_trainee_name ?? '',
          parentName: forms.orthopedic_parent_name ?? '',
          pdfUrl,
        }
      : null,
  });
}
