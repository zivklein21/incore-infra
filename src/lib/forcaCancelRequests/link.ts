import { isLaterThan58, LATE_WARNING, SUGGESTION_LABEL, suggestedEnd, type Suggestion58 } from './rules';
import { changeRequest, loadReceipt, loadState, logOnly, type Actor, type RequestState } from './store';

// How the cancel sheet and the partial refund tie into a request:
//  - the cancel summary (preview) shows section 5.8's date and warns when Or picks later;
//  - applying a stop with the request's id sets the parent's status to
//    "מועד סיום שנקבע: <last active day>" by itself; removing that stop puts
//    the request back to "בטיפול";
//  - a refund given from the request is written in its audit log.
// The request never drives the stop or the refund: Or does, these only record it.

export type LinkedRequest = { state: RequestState; receivedAt: string; suggestion: Suggestion58 };

/** The request `requestId` for this child, or an error code. */
export async function loadLinkedRequest(requestId: string, childUid: string): Promise<LinkedRequest | { error: string }> {
  const [state, receipt] = await Promise.all([loadState(requestId), loadReceipt(requestId)]);
  if (!state || !receipt) return { error: 'request_not_found' };
  if (receipt.child.uid !== childUid) return { error: 'request_other_child' };
  return { state, receivedAt: receipt.receivedAt, suggestion: suggestedEnd(receipt.receivedAt) };
}

export const isLinkError = (v: LinkedRequest | { error: string }): v is { error: string } => 'error' in v;

/** What the cancel summary adds for a request: the 5.8 date, and a warning when the end is later. */
export function requestPreviewExtras(link: LinkedRequest, lastActiveDay: string | null, stopDay: string | null) {
  const late = isLaterThan58(lastActiveDay, link.suggestion);
  return {
    request: {
      requestId: link.state.requestId,
      requestNumber: link.state.requestNumber,
      receivedAt: link.receivedAt,
      suggestedStopDay: link.suggestion.stopDay,
      suggestedLastActiveDay: link.suggestion.lastActiveDay,
      label: SUGGESTION_LABEL,
      isSuggested: stopDay === link.suggestion.stopDay,
    },
    warning: late ? { code: 'later_than_5_8', message: LATE_WARNING } : null,
  };
}

/** After a stop was applied for the request: end date set (the last active day). */
export async function markEndDateFromStop(
  requestId: string, by: Actor, p: { endDate: string; agreementId: string; productName: string; mode: string; stopDay: string },
): Promise<RequestState | null> {
  return changeRequest(requestId, by, (s) => ({
    patch: {
      status: 'end_date_set', endDate: p.endDate, agreementId: p.agreementId, productName: p.productName,
      ...(s.seenAt ? {} : { seenAt: new Date().toISOString() }),
    },
    action: 'end_date_from_stop',
    details: { mode: p.mode, stopDay: p.stopDay },
  }));
}

/** The request's stop was removed: back to "בטיפול" unless Or already closed it. */
export async function markStopRemoved(requestId: string, by: Actor, stopDay: string): Promise<RequestState | null> {
  return changeRequest(requestId, by, (s) => ({
    patch: s.status === 'end_date_set' ? { status: 'in_progress', endDate: null } : {},
    action: 'stop_removed',
    details: { stopDay },
  }));
}

export async function logRefundOnRequest(
  requestId: string, by: Actor, refund: { refundId: string; amount: number; status: string; manualReason?: string },
): Promise<void> {
  try {
    await logOnly(requestId, by, 'refund', refund);
  } catch (err) {
    console.error(`[forcaCancelRequest] ${requestId} could not log refund ${refund.refundId}:`, err);
  }
}
