import {
  CHOICE_LABEL, EARLY_LEGAL_FLAG, choiceOf, isLaterThan58, LATE_WARNING, SUGGESTION_LABEL, suggestedEnd, suggestionUseFor,
  type ParentChoice, type Suggestion58,
} from './rules';
import { changeRequest, loadReceipt, loadState, logOnly, type Actor, type RequestState } from './store';

// How the cancel sheet and the partial refund tie into a request:
//  - the cancel summary (preview) shows section 5.8's date and warns when Or picks later;
//  - applying a stop with the request's id sets the parent's status to
//    "מועד סיום שנקבע: <last active day>" by itself; removing that stop puts
//    the request back to "בטיפול";
//  - a refund given from the request is written in its audit log.
// The request never drives the stop or the refund: Or does, these only record it.

export type LinkedRequest = { state: RequestState; receivedAt: string; suggestion: Suggestion58; choice: ParentChoice | null };

/** The request `requestId` for this child, or an error code. */
export async function loadLinkedRequest(requestId: string, childUid: string): Promise<LinkedRequest | { error: string }> {
  const [state, receipt] = await Promise.all([loadState(requestId), loadReceipt(requestId)]);
  if (!state || !receipt) return { error: 'request_not_found' };
  if (receipt.child.uid !== childUid) return { error: 'request_other_child' };
  return { state, receivedAt: receipt.receivedAt, suggestion: suggestedEnd(receipt.receivedAt), choice: choiceOf(state) };
}

export const isLinkError = (v: LinkedRequest | { error: string }): v is { error: string } => 'error' in v;

/**
 * What the cancel summary adds for a request: the 5.8 date, and a warning when
 * the end is later. Since the parent's choice: `suggestionUse` says how the
 * sheet treats the 5.8 date (preselect for א, hint only for ג, none for ב);
 * the fields stay for builds that don't know it. No 5.8 warning for ב.
 */
export function requestPreviewExtras(link: LinkedRequest, lastActiveDay: string | null, stopDay: string | null) {
  const use = suggestionUseFor(link.choice);
  const late = use !== 'none' && isLaterThan58(lastActiveDay, link.suggestion);
  return {
    request: {
      requestId: link.state.requestId,
      requestNumber: link.state.requestNumber,
      receivedAt: link.receivedAt,
      suggestedStopDay: link.suggestion.stopDay,
      suggestedLastActiveDay: link.suggestion.lastActiveDay,
      label: SUGGESTION_LABEL,
      isSuggested: use !== 'none' && stopDay === link.suggestion.stopDay,
      choice: link.choice,
      choiceLabel: link.choice ? CHOICE_LABEL[link.choice] : null,
      suggestionUse: use,
      ...(link.choice === 'early_legal' ? { flag: EARLY_LEGAL_FLAG } : {}),
      distanceSaleWarning: link.state.distanceSale?.warn ? link.state.distanceSale.message : null,
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
      ...(s.legalEnd ? { legalEnd: null } : {}),
      ...(s.seenAt ? {} : { seenAt: new Date().toISOString() }),
    },
    action: 'end_date_from_stop',
    details: { mode: p.mode, stopDay: p.stopDay },
  }));
}

/** Option ב: Or set the legal date; access ends that day. The parent sees it as the end date. */
export async function markLegalEnd(
  requestId: string, by: { uid: string; name: string },
  p: { legalDay: string; paidThroughDay: string | null; agreementId: string; productName: string; mode: string; stopDay: string | null; sessionsRemoved: number },
): Promise<RequestState | null> {
  return changeRequest(requestId, by, (s) => ({
    patch: {
      status: 'end_date_set', endDate: p.legalDay, agreementId: p.agreementId, productName: p.productName,
      legalEnd: { legalDay: p.legalDay, paidThroughDay: p.paidThroughDay, setAt: new Date().toISOString(), setBy: by },
      ...(s.seenAt ? {} : { seenAt: new Date().toISOString() }),
    },
    action: 'legal_end_set',
    details: { mode: p.mode, stopDay: p.stopDay, paidThroughDay: p.paidThroughDay, accessEnds: p.legalDay, sessionsRemoved: p.sessionsRemoved },
  }));
}

/** The request's stop was removed: back to "בטיפול" unless Or already closed it. */
export async function markStopRemoved(requestId: string, by: Actor, stopDay: string): Promise<RequestState | null> {
  return changeRequest(requestId, by, (s) => ({
    patch: s.status === 'end_date_set' ? { status: 'in_progress', endDate: null, ...(s.legalEnd ? { legalEnd: null } : {}) } : {},
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
