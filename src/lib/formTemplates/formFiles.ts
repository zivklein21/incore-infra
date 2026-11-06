import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { s3 } from '../s3';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { formAssignmentKey } from './shared';
import { resolveFamilyCaller } from './familyForms';
import type { Answers } from './logic';
import { assignmentKey, Brand, FormAssignmentItem, formsTable, getTemplateHead, getTemplateVersion, latestByAssignment, listSubmissionsOfChild, versionToSign } from './submissions';
import { PDF_URL_TTL_SECONDS, signedFormsBucket } from './signedPdf';

// Files a family attaches to a form ("File upload" fields — e.g. a medical
// certificate, asked only when a Yes/No answer is Yes via the field's
// "Show only if" condition). Same private SSE-KMS bucket as the signed PDFs:
//
//   1. getFormUploadUrl → presigned PUT to
//        uploads-pending/{childId}/{templateId}/{assignmentId}/{fieldId}/{uuid}
//      (a lifecycle rule expires anything left there — abandoned picks).
//   2. submitFormPart → commitFormFiles(): checks each new file answer's key
//      belongs to THIS child/form/assignment/field and the object exists
//      (≤ MAX_FILE_BYTES), then copies it to
//        signed-forms/{childId}/form-files/{templateId}/{submissionId}/{fieldId}/{uuid}
//      — under signed-forms/, so the bucket policy's deny-delete protects it
//      exactly like the signed PDF. The answer keeps { name, key, size, contentType }.
//   3. Reads only via short-lived presigned URLs (getSignedFormPdfUrl.ts with
//      &fieldId=, same admin / parent / the child herself access rule).

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const PENDING_PREFIX = 'uploads-pending';

export interface FileAnswer { name: string; key?: string; size?: number; contentType?: string }

export const isFileAnswer = (v: unknown): v is FileAnswer =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as FileAnswer).name === 'string';

const pendingPrefix = (childId: string, templateId: string, assignmentId: string, fieldId: string) =>
  `${PENDING_PREFIX}/${childId}/${templateId}/${assignmentId}/${fieldId}/`;

const safeContentType = (v: unknown) =>
  typeof v === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(v) ? v : 'application/octet-stream';

// POST /getFormUploadUrl
// Body: { templateId, assignmentId, childId?, fieldId, fileName, contentType, size }
// Auth: same family caller as submitFormPart (the parent for her linked
// child, or the trainee herself). Returns { uploadUrl, key, headers } — PUT
// the file's bytes to uploadUrl with those headers, then send
// { name, key } as the field's answer in submitFormPart.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : '';
  const fieldId = typeof body.fieldId === 'string' ? body.fieldId : '';
  const size = typeof body.size === 'number' ? body.size : 0;
  if (!templateId || !assignmentId || !fieldId) return json(400, { error: 'missing_fields' });
  if (size > MAX_FILE_BYTES) return json(400, { error: 'file_too_large', maxBytes: MAX_FILE_BYTES });

  const caller = await resolveFamilyCaller(uid, typeof body.childId === 'string' ? body.childId : undefined);
  if (!caller) return json(403, { error: 'forbidden' });

  const [head, assignmentRes, subs] = await Promise.all([
    getTemplateHead(caller.brand, templateId),
    ddb.send(new GetCommand({ TableName: formsTable(caller.brand), Key: formAssignmentKey(templateId, assignmentId) })),
    listSubmissionsOfChild(caller.brand, caller.childId),
  ]);
  const assignment = assignmentRes.Item as FormAssignmentItem | undefined;
  if (!head || head.status !== 'published' || !assignment || assignment.cancelledAt) return json(404, { error: 'not_found' });
  const { version } = versionToSign(head, latestByAssignment(subs, caller.childId).get(assignmentKey(templateId, assignmentId)));
  const t = await getTemplateVersion(caller.brand, templateId, version);
  if (!t?.sections.some(s => s.fields.some(f => f.id === fieldId && f.type === 'file'))) return json(400, { error: 'not_a_file_field' });

  const contentType = safeContentType(body.contentType);
  const key = `${pendingPrefix(caller.childId, templateId, assignmentId, fieldId)}${randomUUID()}`;
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: signedFormsBucket(caller.brand), Key: key, ContentType: contentType,
  }), { expiresIn: 600 });
  return json(200, { uploadUrl, key, headers: { 'Content-Type': contentType } });
}

/**
 * Called by submitFormPart for the answers it's about to save: every file
 * answer of this role that still points at uploads-pending/ is verified
 * (right child/form/assignment/field, exists, size) and copied under
 * signed-forms/. Already-committed answers (a previous part's) pass through
 * untouched. Returns the answers with committed keys, or an error code.
 */
export async function commitFormFiles(params: {
  brand: Brand; childId: string; templateId: string; assignmentId: string; submissionId: string;
  fileFieldIds: string[]; answers: Answers; previous: Answers;
}): Promise<{ answers: Answers } | { error: string; fieldId: string }> {
  const { brand, childId, templateId, assignmentId, submissionId } = params;
  const Bucket = signedFormsBucket(brand);
  const out: Answers = { ...params.answers };
  for (const fieldId of params.fileFieldIds) {
    const value = out[fieldId];
    if (value === undefined) continue;
    if (!isFileAnswer(value) || !value.key) return { error: 'file_not_uploaded', fieldId };
    const prev = params.previous[fieldId];
    if (isFileAnswer(prev) && prev.key === value.key && value.key.startsWith('signed-forms/')) continue;
    if (!value.key.startsWith(pendingPrefix(childId, templateId, assignmentId, fieldId))) return { error: 'invalid_file', fieldId };

    let headRes;
    try {
      headRes = await s3.send(new HeadObjectCommand({ Bucket, Key: value.key }));
    } catch {
      return { error: 'file_not_uploaded', fieldId };
    }
    const size = headRes.ContentLength ?? 0;
    if (size > MAX_FILE_BYTES) return { error: 'file_too_large', fieldId };
    const contentType = safeContentType(headRes.ContentType);
    const committedKey = `signed-forms/${childId}/form-files/${templateId}/${submissionId}/${fieldId}/${value.key.split('/').pop()}`;
    await s3.send(new CopyObjectCommand({
      Bucket, Key: committedKey, CopySource: `${Bucket}/${value.key}`, ServerSideEncryption: 'aws:kms',
    }));
    out[fieldId] = { name: value.name.slice(0, 200), key: committedKey, size, contentType } as FileAnswer;
  }
  return { answers: out };
}

/** Short-lived presigned GET for an attached file (only committed ones). */
export async function presignFormFile(brand: Brand, file: FileAnswer): Promise<string | null> {
  if (!file.key?.startsWith('signed-forms/')) return null;
  const filename = file.name.replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'file';
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: signedFormsBucket(brand),
    Key: file.key,
    ...(file.contentType ? { ResponseContentType: file.contentType } : {}),
    ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
  }), { expiresIn: PDF_URL_TTL_SECONDS });
}
