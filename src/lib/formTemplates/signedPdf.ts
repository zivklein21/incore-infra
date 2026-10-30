import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { s3, BUCKET_NAME } from '../s3';
import { ddb } from '../dynamo';
import { renderFormPdf } from './pdf/renderFormPdf';
import { formsTable, FormSubmissionItem, getProfile, getTemplateVersion } from './submissions';
import { deriveMemberName } from '../entities';
import { writeAudit } from './audit';

// Signed PDFs of completed FORCA forms. They live in their own bucket
// (s3.tf's forca_signed_forms: private, SSE-KMS, versioning on, and a bucket
// policy that denies every delete), under
//
//   signed-forms/{childId}/{formCode}/v{version}/{submissionId}_{YYYYMMDD-HHmmss}.pdf
//
// Written with If-None-Match: * so a key is never overwritten, even by a
// retry. The submission keeps the key + SHA-256 of the exact bytes; they're
// only ever handed out as short-lived presigned URLs (getSignedFormPdfUrl.ts).
//
// "Preview PDF" samples go under previews/ in the same bucket, which a
// lifecycle rule expires after a day — they're never signed documents.

export const SIGNED_FORMS_BUCKET = process.env.SIGNED_FORMS_BUCKET || 'forca-production-signed-forms';
export const PDF_URL_TTL_SECONDS = 300;

let logoCache: Uint8Array | null | undefined;
/** The white-on-pink FORCA wordmark used in emails (s3.tf's public email-assets/ prefix). */
export async function forcaLogo(): Promise<Uint8Array | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: 'email-assets/ForcaLogoEmail.png' }));
    logoCache = res.Body ? await res.Body.transformToByteArray() : null;
  } catch (err) {
    console.warn('[signedPdf] logo unavailable, using text', err);
    logoCache = null;
  }
  return logoCache;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHmmss (UTC)
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '') || 'FORM';

/**
 * Renders and stores the PDF of a completed submission and records its key
 * + hash. Idempotent per submission: if it already has a PDF, returns it.
 * A failure leaves the submission completed without a PDF — the next
 * download request (getSignedFormPdfUrl.ts) generates it then.
 */
export async function ensureSignedPdf(sub: FormSubmissionItem, actorUid: string): Promise<{ key: string; sha256: string }> {
  if (sub.pdfS3Key && sub.pdfSha256) return { key: sub.pdfS3Key, sha256: sub.pdfSha256 };
  if (sub.status !== 'completed') throw new Error('not_completed');
  const version = await getTemplateVersion(sub.templateId, sub.version);
  if (!version) throw new Error('version_missing');
  const child = await getProfile(sub.childId);
  const generatedAt = new Date();
  const code = version.settings.code || safeSegment(version.name).slice(0, 12) || 'FORM';

  const bytes = await renderFormPdf({
    title: version.name,
    code: version.settings.code,
    version: sub.version,
    sections: version.sections,
    answers: sub.answers,
    signatures: sub.signatures,
    acknowledgments: sub.acknowledgments,
    submissionId: sub.submissionId,
    childName: child ? deriveMemberName(child) : '',
    generatedAt,
    logoPng: await forcaLogo(),
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `signed-forms/${safeSegment(sub.childId)}/${safeSegment(code)}/v${sub.version}/${sub.submissionId}_${stamp(generatedAt)}.pdf`;

  await s3.send(new PutObjectCommand({
    Bucket: SIGNED_FORMS_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'aws:kms',
    ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    IfNoneMatch: '*',
    Metadata: { submission: sub.submissionId, sha256 },
  }));

  // Record it only if no concurrent request recorded another one first (both files are kept either way).
  try {
    await ddb.send(new UpdateCommand({
      TableName: formsTable(),
      Key: { PK: sub.PK, SK: sub.SK },
      UpdateExpression: 'SET pdfS3Key = :k, pdfSha256 = :h, pdfGeneratedAt = :at',
      ConditionExpression: 'attribute_not_exists(pdfS3Key)',
      ExpressionAttributeValues: { ':k': key, ':h': sha256, ':at': generatedAt.toISOString() },
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  await writeAudit({ action: 'pdf', templateId: sub.templateId, submissionId: sub.submissionId, childId: sub.childId, actorUid, detail: { key, sha256 } });
  return { key, sha256 };
}

export async function presignPdf(key: string, filename: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: SIGNED_FORMS_BUCKET,
    Key: key,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
  }), { expiresIn: PDF_URL_TTL_SECONDS });
}

/** "Preview PDF" sample → previews/ (expires after a day) → presigned URL. */
export async function storePreviewPdf(bytes: Uint8Array, templateId: string): Promise<string> {
  const key = `previews/${safeSegment(templateId)}/${stamp(new Date())}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: SIGNED_FORMS_BUCKET, Key: key, Body: bytes, ContentType: 'application/pdf', ServerSideEncryption: 'aws:kms' }));
  return presignPdf(key, 'sample.pdf');
}
