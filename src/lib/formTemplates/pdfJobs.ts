import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { BackgroundJob } from '../backgroundJobTypes';
import { ddb } from '../dynamo';
import { consentHistory, ensureConsentPdf } from '../photoConsent/store';
import { ensureSignedPdf } from './signedPdf';
import { formsTable, type FormSubmissionItem } from './submissions';

/** Both PDFs are idempotent, so Lambda's automatic retries are safe. */
export async function handleBackgroundJob(job: BackgroundJob): Promise<void> {
  if (job.job === 'signed_form_pdf') {
    const res = await ddb.send(new GetCommand({ TableName: formsTable(job.brand), Key: { PK: job.pk, SK: job.sk } }));
    if (res.Item) await ensureSignedPdf(job.brand, res.Item as FormSubmissionItem, job.actorUid);
    return;
  }
  const log = (await consentHistory(job.childId)).find((h) => h.id === job.logId);
  if (log) await ensureConsentPdf(log);
}
