import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';

// Append-only audit log for FORCA's forms system: who created, edited,
// published, archived, deleted, assigned and signed what, and when (server
// time, always). One partition, PK=FORM_AUDIT, SK=<iso>#<uuid> so a Query
// reads it newest-last; at this app's scale (dozens of families) a single
// partition is nowhere near any DynamoDB limit. Nothing ever updates or
// deletes these items.
//
// Never throws: an audit write failing must not undo (or report as failed)
// the action it describes, which has already been committed — it's logged
// instead so it shows up in CloudWatch.

export type FormAuditAction =
  | 'create' | 'edit' | 'publish' | 'archive' | 'delete' | 'assign' | 'unassign' | 'sign' | 'acknowledge' | 'complete' | 'pdf' | 'remind';

export async function writeAudit(entry: {
  action: FormAuditAction;
  templateId: string;
  actorUid: string;
  submissionId?: string;
  childId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const at = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
      TableName: tableForBrand('forca'),
      Item: { PK: 'FORM_AUDIT', SK: `${at}#${randomUUID()}`, at, ...entry },
    }));
  } catch (err) {
    console.error('[formAudit] write failed', entry.action, entry.templateId, err);
  }
}
