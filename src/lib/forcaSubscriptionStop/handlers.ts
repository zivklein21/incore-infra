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

// FORCA admin cancel — two routes on the shared integration (incoreWorkoutApi.ts):
//   POST adminForcaSubscriptionStopPreview  { agreementId, mode?, stopDay? }
//        → the summary for a choice (nothing saved), plus the current
//          scheduled stop, the exit point and the audit trail
//   POST adminForcaSubscriptionStop         { agreementId, action: 'apply', mode, stopDay?, reason, parentRequestId?, expectedStopDay? }
//                                           { agreementId, action: 'remove', expectedStopDay? }
//        apply + now → runs at once; apply + period_end/date → schedules (or edits) the stop
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
  return { agreement, periods, membershipEnd: await membershipEndDay(agreement.userId), today: israelDateStrOf(new Date()) };
}

const isResult = (v: Loaded | Result): v is Result => 'statusCode' in v;

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
  let preview: StopPreview | null = null;
  if (body.mode !== undefined) {
    const res = compute(l, body.mode, body.stopDay);
    if (!res.ok) return json(400, { error: res.error });
    preview = await withCardWarning(res.value, card);
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
    log: await listStopLog(l.agreement.agreementId),
  });
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
    const res = await removeScheduledStop(agreement, uid, name);
    if (res === 'none') return json(404, { error: 'no_scheduled_stop' });
    if (res === 'conflict') return json(409, { error: 'conflict' });
    console.log(`[adminForcaSubscriptionStop] agreement=${agreement.agreementId} stop removed by ${uid}`);
    return json(200, { success: true, scheduledStop: null });
  }

  const details = validateStopDetails(body);
  if (!details.ok) return json(400, { error: details.error });
  const res = compute(l, body.mode, body.stopDay);
  if (!res.ok) return json(400, { error: res.error });
  const preview = res.value;

  if (preview.mode === 'now') {
    const run = await runStop(agreement, {
      mode: 'now', stopDay: preview.stopDay, reason: details.reason, parentRequestId: details.parentRequestId,
      requestedBy: uid, requestedByName: name, requestedAt: nowIso,
    }, uid, name);
    if (!run.stopped) return json(409, { error: 'already_cancelled' });
    return json(200, { success: true, cancellation: run.cancellation, preview });
  }

  const stop: ForcaScheduledStop = {
    mode: preview.mode,
    stopDay: preview.stopDay,
    reason: details.reason,
    ...(details.parentRequestId ? { parentRequestId: details.parentRequestId } : {}),
    by: agreement.scheduledStop?.by ?? uid,
    byName: agreement.scheduledStop?.byName ?? name,
    at: agreement.scheduledStop?.at ?? nowIso,
    ...(agreement.scheduledStop ? { updatedAt: nowIso } : {}),
  };
  const saved = await saveScheduledStop(agreement, stop, { uid, name });
  if (saved === 'conflict') return json(409, { error: 'conflict' });
  console.log(`[adminForcaSubscriptionStop] agreement=${agreement.agreementId} stop ${agreement.scheduledStop ? 'edited' : 'scheduled'} for ${stop.stopDay} (${stop.mode}) by ${uid}`);
  return json(200, { success: true, scheduledStop: stop, preview });
}
