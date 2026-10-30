import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { verifyFamilyLink } from '../familyLinks';
import { listSubmissionsOfTemplate } from './submissions';
import { ensureSignedPdf, PDF_URL_TTL_SECONDS, presignPdf } from './signedPdf';

// GET /getSignedFormPdfUrl?templateId=<id>&submissionId=<id>
// Auth: Cognito JWT — an admin, or the linked PARENT of the submission's
// child (verifyFamilyLink). Returns { url, expiresIn, sha256 }: a
// short-lived presigned URL to the signed PDF — the bucket itself is
// private. If the completed submission has no PDF yet (generation failed
// at completion), it's generated now.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const templateId = event.queryStringParameters?.templateId ?? '';
  const submissionId = event.queryStringParameters?.submissionId ?? '';
  if (!templateId || !submissionId) return json(400, { error: 'missing_fields' });

  const sub = (await listSubmissionsOfTemplate(templateId)).find(s => s.submissionId === submissionId);
  if (!sub) return json(404, { error: 'not_found' });
  const allowed = (await isAdmin(uid)) || (uid !== sub.childId && (await verifyFamilyLink(uid, sub.childId)).ok);
  if (!allowed) return json(403, { error: 'forbidden' });
  if (sub.status !== 'completed') return json(409, { error: 'not_completed' });

  const { key, sha256 } = await ensureSignedPdf(sub, uid);
  const url = await presignPdf(key, `${submissionId}.pdf`);
  return json(200, { url, expiresIn: PDF_URL_TTL_SECONDS, sha256 });
}
