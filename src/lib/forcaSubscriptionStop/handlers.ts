import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { israelDateStrOf } from '../israelTime';
import { deriveMemberName, type ForcaBillingAgreementItem, type ForcaScheduledStop } from '../entities';
import { resolveMemberProfile } from '../memberLookup';
import { addDays, currentPeriodEnd, type ActivityPeriod } from '../forcaPeriods/rules';
import { displayName, loadForcaProfiles, loadPeriodSettings } from '../forcaPeriods/store';
import { previewStop, validateStopDetails, type StopPreview } from './rules';
import {
  listStopLog, loadAgreement, membershipEndDay, removeScheduledStop, runStop, saveScheduledStop, savedCardFate, type SavedCardFate,
} from './store';
import {
  isLinkError, loadLinkedRequest, markEndDateFromStop, markLegalEnd, markStopRemoved, requestPreviewExtras, type LinkedRequest,
} from '../forcaCancelRequests/link';
import { legalDateToStop } from '../forcaCancelRequests/rules';
import { buildSuggestionAfter, suggestionAfterLabel } from '../forcaRefunds/between';
import { cutAccessAt, previewAccessCut, restoreAccess } from './access';
import { REFUND_NOTE } from './rules';
import type { ForcaAccessCut } from '../entities';

// FORCA admin cancel — two routes on the shared integration (incoreWorkoutApi.ts):
//   POST adminForcaSubscriptionStopPreview  { agreementId, mode?, stopDay? }
//        → the summary for a choice (nothing saved), plus the current
//          scheduled stop, the exit point and the audit trail
//   POST adminForcaSubscriptionStop         { agreementId, action: 'apply', mode, stopDay?, reason, parentRequestId?, expectedStopDay? }
//                                           { agreementId, action: 'remove', expectedStopDay? }
//        apply + now → runs at once; apply + period_end/date → schedules (or edits) the stop
// With parentRequestId (opened from a parent's cancellation request): the
// preview adds section 5.8's date and warns when the end is later; applying
// sets the request to "מועד סיום שנקבע" and removing the stop puts it back to
// "בטיפול" (lib/forcaCancelRequests/link.ts). Since the parent's choice
// (2026-11-20), with parentRequestId also:
//   legalEffectiveDay "YYYY-MM-DD"  option ב: Or's legal date D. The server
//        derives the stop (D today or earlier → now; later → stop day D+1),
//        the trainee's access ends at D (access.ts), the request's end date is
//        D, and the summary/answer carry the refund suggestion for after D.
//        Required when the request's choice is ב.
// Removing a stop that cut access puts the access back. Editing a stop from
// the subscription card keeps the request it came from.
// Admin only (Or). New routes: nothing an existing build calls changes.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

function parseBody(event: Event): Record<string, unknown> | null {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function adminName(uid: string): Promise<string> {
  try {
    const r = await resolveMemberProfile(uid);
    return r ? deriveMemberName(r.profile) : uid;
  } catch {
    return uid;
  }
}

type Loaded = { agreement: ForcaBillingAgreementItem; periods: ActivityPeriod[]; membershipEnd: string | null; today: string };

async function load(body: Record<string, unknown>): Promise<Loaded | Result> {
  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  if (!agreementId) return json(400, { error: 'missing_agreement_id' });
  const agreement = await loadAgreement(agreementId);
  if (!agreement) return json(404, { error: 'agreement_not_found' });
  let periods: ActivityPeriod[];
  try {
    periods = (await loadPeriodSettings()).periods;
  } catch (err) {
    console.error('[forcaSubscriptionStop] periods unreadable:', err);
    return json(503, { error: 'periods_unreadable' });
  }
  // A stop that cut access (option ב): what was paid for is the end from before the cut.
  const cut = agreement.scheduledStop?.accessCut;
  const membershipEnd = cut ? (cut.previousEnd ? israelDateStrOf(new Date(cut.previousEnd)) : null) : await membershipEndDay(agreement.userId);
  return { agreement, periods, membershipEnd, today: israelDateStrOf(new Date()) };
}

type LegalPlan = { legalDay: string; mode: 'now' | 'date'; stopDay: string; paidThroughDay: string | null; preview: StopPreview; alreadyCancelled: boolean };

const ACCESS_WARNINGS_REPLACED = new Set(['stop_month_not_charged', 'this_month_not_charged']);

/** Option ב: the stop and the summary for legal date D (access ends at D). */
function legalPlan(l: Loaded, link: LinkedRequest, raw: unknown): { ok: true; value: LegalPlan } | { ok: false; error: string } {
  const v = legalDateToStop(raw, link.suggestion.receivedDay, l.today);
  if (!v.ok) return v;
  if (l.agreement.status === 'cancelled') {
    // Charges already stopped: only the access and the request's date change.
    return {
      ok: true,
      value: {
        legalDay: v.legalDay, mode: 'now', stopDay: l.today, paidThroughDay: l.membershipEnd, alreadyCancelled: true,
        preview: {
          mode: 'now', stopDay: l.today, remainingCharges: [], remainingTotal: 0, lastActiveDay: v.legalDay, cardDeletedOn: l.today,
          warnings: [{ code: 'already_cancelled', message: 'המנוי כבר בוטל: החיובים כבר הופסקו. רק הגישה תסתיים והמועד יירשם בבקשה.' }],
          refundNote: REFUND_NOTE,
        },
      },
    };
  }
  // A subscription the charge job gave up on has nothing to charge: stop it now.
  const mode = l.agreement.status === 'failed' ? 'now' : v.mode;
  const res = compute(l, mode, mode === 'date' ? v.stopDay : undefined);
  if (!res.ok) return res;
  return {
    ok: true,
    value: {
      legalDay: v.legalDay, mode, stopDay: res.value.stopDay, paidThroughDay: res.value.lastActiveDay, alreadyCancelled: false,
      preview: { ...res.value, lastActiveDay: v.legalDay, warnings: res.value.warnings.filter((w) => !ACCESS_WARNINGS_REPLACED.has(w.code)) },
    },
  };
}

const dayLabel = (d: string) => d.split('-').reverse().join('/');

/** What the summary shows for option ב before Or confirms. */
async function legalSummary(l: Loaded, plan: LegalPlan) {
  const [access, refund] = await Promise.all([
    previewAccessCut(l.agreement.userId, plan.legalDay),
    buildSuggestionAfter(l.agreement.groupId ?? null, plan.legalDay, plan.paidThroughDay),
  ]);
  const cut = l.agreement.scheduledStop?.accessCut;
  return {
    legalDay: plan.legalDay,
    mode: plan.mode,
    stopDay: plan.alreadyCancelled ? null : plan.stopDay,
    accessEnds: plan.legalDay,
    paidThroughDay: plan.paidThroughDay,
    currentEnd: cut ? cut.previousEnd : access.currentEnd,
    sessionsRemoved: access.sessionsRemoved,
    accessMessage: `הגישה של המתאמנת תסתיים ב-${dayLabel(plan.legalDay)}`
      + (access.sessionsRemoved ? `, והיא תוסר מ-${access.sessionsRemoved} אימונים מתוכננים אחרי מועד זה.` : '.'),
    refundSuggestion: { ...refund, label: suggestionAfterLabel(refund) },
  };
}

const isResult = (v: Loaded | Result): v is Result => 'statusCode' in v;
const isLinkResult = (v: LinkedRequest | null | Result): v is Result => !!v && 'statusCode' in v;

function compute(l: Loaded, mode: unknown, stopDay: unknown) {
  const due = l.agreement.nextChargeDate ? new Date(l.agreement.nextChargeDate) : null;
  return previewStop({
    mode, stopDay, today: l.today, periods: l.periods, status: l.agreement.status,
    dueDay: due && !Number.isNaN(due.getTime()) ? israelDateStrOf(due) : null,
    amount: l.agreement.amountPerCharge, membershipEnd: l.membershipEnd,
  });
}

async function withCardWarning(preview: StopPreview, card: SavedCardFate): Promise<StopPreview> {
  if (!card.hasSavedCard || card.willDelete) return preview;
  const profiles = await loadForcaProfiles(card.keptForSiblings);
  const names = card.keptForSiblings.map((id) => displayName(profiles.get(id))).filter(Boolean).join(', ') || 'ילדה אחרת';
  return {
    ...preview,
    warnings: [...preview.warnings, {
      code: 'saved_card_kept',
      message: `הכרטיס השמור של ההורה לא יימחק כי הוא משמש גם את המנוי של ${names}. הכרטיס יימחק מהמנוי הזה בלבד.`,
    }],
  };
}

export async function adminForcaSubscriptionStopPreview(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_body' });
  const l = await load(body);
  if (isResult(l)) return l;

  const periodEnd = currentPeriodEnd(l.periods, l.today);
  const card = await savedCardFate(l.agreement);
  const link = await requestLink(body, l.agreement);
  if (isLinkResult(link)) return link;
  let preview: StopPreview | null = null;
  let request: ReturnType<typeof requestPreviewExtras>['request'] | null = link ? requestPreviewExtras(link, null, null).request : null;
  if (body.legalEffectiveDay !== undefined) {
    if (!link) return json(400, { error: 'legal_day_needs_request' });
    const plan = legalPlan(l, link, body.legalEffectiveDay);
    if (!plan.ok) return json(400, { error: plan.error });
    const summary = await legalSummary(l, plan.value);
    preview = await withCardWarning(plan.value.preview, card);
    preview = { ...preview, warnings: [{ code: 'access_cut', message: summary.accessMessage }, ...preview.warnings] };
    request = requestPreviewExtras(link, plan.value.legalDay, null).request;
    return json(200, {
      agreementId: l.agreement.agreementId, status: l.agreement.status, today: l.today,
      periodEndStopDay: periodEnd ? addDays(periodEnd, 1) : null, currentPeriodEnd: periodEnd, membershipEnd: l.membershipEnd,
      savedCard: { hasSavedCard: card.hasSavedCard, willDelete: card.willDelete },
      scheduledStop: l.agreement.scheduledStop ?? null, cancellation: l.agreement.cancellation ?? null,
      preview, request, legal: summary, log: await listStopLog(l.agreement.agreementId),
    });
  }
  if (body.mode !== undefined) {
    const res = compute(l, body.mode, body.stopDay);
    if (!res.ok) return json(400, { error: res.error });
    preview = await withCardWarning(res.value, card);
    if (link) {
      const extras = requestPreviewExtras(link, preview.lastActiveDay, preview.mode === 'now' ? null : preview.stopDay);
      request = extras.request;
      // On section 5.8's own date, "the month isn't charged" is the point, not a warning.
      const warnings = preview.warnings.filter((w) => !(extras.request.isSuggested && w.code === 'stop_month_not_charged'));
      preview = { ...preview, warnings: extras.warning ? [extras.warning, ...warnings] : warnings };
    }
  }
  return json(200, {
    agreementId: l.agreement.agreementId,
    status: l.agreement.status,
    today: l.today,
    // Option 2's stop day, or null between periods (option not offered).
    periodEndStopDay: periodEnd ? addDays(periodEnd, 1) : null,
    currentPeriodEnd: periodEnd,
    membershipEnd: l.membershipEnd,
    savedCard: { hasSavedCard: card.hasSavedCard, willDelete: card.willDelete },
    scheduledStop: l.agreement.scheduledStop ?? null,
    cancellation: l.agreement.cancellation ?? null,
    preview,
    ...(request ? { request } : {}),
    log: await listStopLog(l.agreement.agreementId),
  });
}

/** The parent request this sheet was opened from, if any (must be for this subscription's child). */
async function requestLink(body: Record<string, unknown>, agreement: ForcaBillingAgreementItem): Promise<LinkedRequest | null | Result> {
  const id = typeof body.parentRequestId === 'string' ? body.parentRequestId.trim() : '';
  if (!id) return null;
  const link = await loadLinkedRequest(id, agreement.userId);
  if (isLinkError(link)) return json(link.error === 'request_not_found' ? 404 : 400, { error: link.error });
  return link;
}

/** Sets the request's end date after a stop; a failure here never undoes the stop. */
async function recordOnRequest(requestId: string | undefined, by: { uid: string; name: string }, agreement: ForcaBillingAgreementItem, preview: StopPreview): Promise<boolean> {
  if (!requestId) return false;
  try {
    await markEndDateFromStop(requestId, by, {
      endDate: preview.lastActiveDay ?? addDays(preview.stopDay, -1),
      agreementId: agreement.agreementId, productName: agreement.productName, mode: preview.mode, stopDay: preview.stopDay,
    });
    return true;
  } catch (err) {
    console.error(`[adminForcaSubscriptionStop] stop applied but request ${requestId} not updated:`, err);
    return false;
  }
}

export async function adminForcaSubscriptionStop(event: Event): Promise<Result> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_body' });
  const action = body.action;
  if (action !== 'apply' && action !== 'remove') return json(400, { error: 'invalid_action' });
  const l = await load(body);
  if (isResult(l)) return l;
  const { agreement } = l;

  // The screen sends the stop it was showing; anything else means it changed in between.
  if (body.expectedStopDay !== undefined && (body.expectedStopDay ?? null) !== (agreement.scheduledStop?.stopDay ?? null)) {
    return json(409, { error: 'conflict', scheduledStop: agreement.scheduledStop ?? null });
  }
  const name = await adminName(uid);
  const nowIso = new Date().toISOString();

  if (action === 'remove') {
    const removed = agreement.scheduledStop;
    const res = await removeScheduledStop(agreement, uid, name);
    if (res === 'none') return json(404, { error: 'no_scheduled_stop' });
    if (res === 'conflict') return json(409, { error: 'conflict' });
    if (removed?.accessCut) await restoreAfterCut(agreement.userId, removed.accessCut);
    if (removed?.parentRequestId) {
      await markStopRemoved(removed.parentRequestId, { uid, name }, removed.stopDay)
        .catch((err) => console.error(`[adminForcaSubscriptionStop] stop removed but request ${removed.parentRequestId} not updated:`, err));
    }
    console.log(`[adminForcaSubscriptionStop] agreement=${agreement.agreementId} stop removed by ${uid}`);
    return json(200, { success: true, scheduledStop: null });
  }

  const details = validateStopDetails(body);
  if (!details.ok) return json(400, { error: details.error });
  const link = await requestLink(body, agreement);
  if (isLinkResult(link)) return link;
  if (body.legalEffectiveDay !== undefined) {
    if (!link) return json(400, { error: 'legal_day_needs_request' });
    return applyLegal(l, link, body.legalEffectiveDay, details.reason, { uid, name });
  }
  if (link?.choice === 'early_legal') return json(400, { error: 'legal_day_required' });
  // Edited from the subscription card: the stop keeps the request it came from.
  const requestId = details.parentRequestId ?? agreement.scheduledStop?.parentRequestId;
  const previousCut = agreement.scheduledStop?.accessCut;
  const res = compute(l, body.mode, body.stopDay);
  if (!res.ok) return json(400, { error: res.error });
  const preview = res.value;

  if (preview.mode === 'now') {
    const run = await runStop(agreement, {
      mode: 'now', stopDay: preview.stopDay, reason: details.reason, parentRequestId: requestId,
      requestedBy: uid, requestedByName: name, requestedAt: nowIso,
    }, uid, name);
    if (!run.stopped) return json(409, { error: 'already_cancelled' });
    if (previousCut) await restoreAfterCut(agreement.userId, previousCut);
    const requestUpdated = await recordOnRequest(requestId, { uid, name }, agreement, preview);
    return json(200, { success: true, cancellation: run.cancellation, preview, ...(requestId ? { requestUpdated } : {}) });
  }

  const stop: ForcaScheduledStop = {
    mode: preview.mode,
    stopDay: preview.stopDay,
    reason: details.reason,
    ...(requestId ? { parentRequestId: requestId } : {}),
    by: agreement.scheduledStop?.by ?? uid,
    byName: agreement.scheduledStop?.byName ?? name,
    at: agreement.scheduledStop?.at ?? nowIso,
    ...(agreement.scheduledStop ? { updatedAt: nowIso } : {}),
  };
  const saved = await saveScheduledStop(agreement, stop, { uid, name });
  if (saved === 'conflict') return json(409, { error: 'conflict' });
  console.log(`[adminForcaSubscriptionStop] agreement=${agreement.agreementId} stop ${agreement.scheduledStop ? 'edited' : 'scheduled'} for ${stop.stopDay} (${stop.mode}) by ${uid}`);
  if (previousCut) await restoreAfterCut(agreement.userId, previousCut);
  const requestUpdated = await recordOnRequest(requestId, { uid, name }, agreement, preview);
  return json(200, { success: true, scheduledStop: stop, preview, ...(requestId ? { requestUpdated } : {}) });
}

/** A failure here is logged; the stop itself already stands. */
async function restoreAfterCut(memberId: string, cut: ForcaAccessCut): Promise<void> {
  await restoreAccess(memberId, cut).catch((err) => console.error(`[adminForcaSubscriptionStop] access not restored member=${memberId}:`, err));
}

/** Option ב: stop for legal date D, access ends at D, the request gets D. */
async function applyLegal(l: Loaded, link: LinkedRequest, raw: unknown, reason: string, by: { uid: string; name: string }): Promise<Result> {
  const { agreement } = l;
  const plan = legalPlan(l, link, raw);
  if (!plan.ok) return json(400, { error: plan.error });
  const p = plan.value;
  const requestId = link.state.requestId;
  const nowIso = new Date().toISOString();
  const existing = agreement.scheduledStop;
  // Editing D keeps the end from before the first cut, so removing the stop still restores it.
  const { cut, sessionsRemoved } = await cutAccessAt(agreement.userId, p.legalDay, by.uid, existing?.accessCut ? existing.accessCut.previousEnd : undefined);

  let result: Record<string, unknown> = {};
  if (!p.alreadyCancelled && p.mode === 'now') {
    const run = await runStop(agreement, {
      mode: 'now', stopDay: p.stopDay, reason, parentRequestId: requestId, requestedBy: by.uid, requestedByName: by.name, requestedAt: nowIso, accessCut: cut,
    }, by.uid, by.name);
    if (!run.stopped) { await restoreAfterCut(agreement.userId, cut); return json(409, { error: 'already_cancelled' }); }
    result = { cancellation: run.cancellation };
  } else if (!p.alreadyCancelled) {
    const stop: ForcaScheduledStop = {
      mode: 'date', stopDay: p.stopDay, reason, parentRequestId: requestId,
      by: existing?.by ?? by.uid, byName: existing?.byName ?? by.name, at: existing?.at ?? nowIso,
      ...(existing ? { updatedAt: nowIso } : {}), accessCut: cut,
    };
    const saved = await saveScheduledStop(agreement, stop, by);
    if (saved === 'conflict') { await restoreAfterCut(agreement.userId, cut); return json(409, { error: 'conflict' }); }
    result = { scheduledStop: stop };
  }
  console.log(`[adminForcaSubscriptionStop] agreement=${agreement.agreementId} legal date ${p.legalDay} (${p.alreadyCancelled ? 'already cancelled' : p.mode}) by ${by.uid}; ${sessionsRemoved} sessions removed`);

  let requestUpdated = true;
  await markLegalEnd(requestId, by, {
    legalDay: p.legalDay, paidThroughDay: p.paidThroughDay, agreementId: agreement.agreementId, productName: agreement.productName,
    mode: p.alreadyCancelled ? 'already_cancelled' : p.mode, stopDay: p.alreadyCancelled ? null : p.stopDay, sessionsRemoved,
  }).catch((err) => { requestUpdated = false; console.error(`[adminForcaSubscriptionStop] legal date set but request ${requestId} not updated:`, err); });
  const refund = await buildSuggestionAfter(agreement.groupId ?? null, p.legalDay, p.paidThroughDay);
  return json(200, {
    success: true, ...result, preview: p.preview, requestUpdated,
    legal: { legalDay: p.legalDay, accessEnds: p.legalDay, paidThroughDay: p.paidThroughDay, sessionsRemoved, refundSuggestion: { ...refund, label: suggestionAfterLabel(refund) } },
  });
}
