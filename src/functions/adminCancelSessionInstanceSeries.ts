import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { json, getUid } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deleteFutureInstances } from '../lib/sessionInstance';

// POST /adminCancelSessionInstanceSeries
// Body: { recurringSessionId: string }
// Auth: Cognito JWT, admin-only — same gating as adminCancelSessionInstance.ts.
//
// The "this and all future occurrences" counterpart of
// adminCancelSessionInstance.ts's single-instance cancel — cancels every
// not-yet-occurred ClassItem generated from this recurring template (same
// deleteFutureInstances() primitive adminSaveRecurringSession.ts's own
// pattern-change path and adminDeleteRecurringSession.ts already build on,
// so this never drifts from what "cancel the future of a series" means
// elsewhere in the codebase). The recurring template itself and every past
// instance are left untouched — same "future only" rule as everywhere else
// this primitive is used.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { recurringSessionId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const recurringSessionId = typeof body.recurringSessionId === 'string' ? body.recurringSessionId.trim() : '';
  if (!recurringSessionId) return json(400, { error: 'missing_recurring_session_id' });

  const cancelledCount = await deleteFutureInstances(recurringSessionId);

  return json(200, { success: true, cancelledCount });
}
