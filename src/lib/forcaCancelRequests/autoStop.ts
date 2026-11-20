import { israelDateStrOf } from '../israelTime';
import type { ForcaScheduledStop } from '../entities';
import { addDays } from '../forcaPeriods/rules';
import { loadPeriodSettings } from '../forcaPeriods/store';
import { previewStop } from '../forcaSubscriptionStop/rules';
import { loadAgreement, membershipEndDay, saveScheduledStop } from '../forcaSubscriptionStop/store';
import { AUTO_STOP_REASON, autoStopSkipped, existingStopOutcome, suggestedEnd, type AutoStopOutcome } from './rules';
import { changeRequest, type RequestState } from './store';

// Option א ("סיום בתום החודש ששולם"): the one thing that happens without Or.
// Right after the request is saved, the stop is scheduled for the 1st of next
// month with the same logic Or's "בתאריך שאבחר" uses (previewStop +
// saveScheduledStop), marked AUTO_STOP_REASON, by 'system'. The request then
// shows "מועד סיום שנקבע: <last active day>".
//
// It never overrides anything: no subscription, one that isn't running, a stop
// that already exists, or any failure → nothing changes and the request is
// flagged for Or (a later existing stop is highlighted). The request was
// received either way. Or edits or removes the stop like any other; every
// change is logged on the subscription and on the request.

const SYSTEM = 'system';
const actor = { system: 'parent_choice' } as const;

async function record(requestId: string, outcome: AutoStopOutcome, extra: Partial<Pick<RequestState, 'status' | 'endDate' | 'agreementId' | 'productName'>> = {}): Promise<RequestState | null> {
  return changeRequest(requestId, actor, () => ({
    patch: { autoStop: outcome, ...extra },
    action: outcome.result === 'scheduled' ? 'end_date_from_stop' : 'auto_stop_skipped',
    details: outcome.result === 'scheduled'
      ? { auto: true, mode: 'date', stopDay: outcome.stopDay, reason: AUTO_STOP_REASON }
      : { auto: true, reason: outcome.reason, message: outcome.message, ...(outcome.existingStopDay ? { existingStopDay: outcome.existingStopDay } : {}) },
  }));
}

/** Schedules option א's stop for a request just received in the app. Never throws. */
export async function applyParentChoiceStop(p: { requestId: string; receivedAt: string; agreementId: string | null }): Promise<{ outcome: AutoStopOutcome; state: RequestState | null }> {
  const s = suggestedEnd(p.receivedAt);
  let outcome: AutoStopOutcome;
  try {
    const agreement = p.agreementId ? await loadAgreement(p.agreementId) : undefined;
    if (!agreement) {
      outcome = autoStopSkipped('no_subscription');
    } else if (agreement.status !== 'active' && agreement.status !== 'frozen') {
      outcome = autoStopSkipped('not_active', agreement.status);
    } else if (agreement.scheduledStop) {
      outcome = existingStopOutcome(agreement.scheduledStop.stopDay, s.stopDay, s.lastActiveDay);
    } else {
      const periods = await loadPeriodSettings().then((r) => r.periods).catch((err) => {
        console.error(`[forcaCancelRequest] ${p.requestId} auto stop: periods unreadable:`, err);
        return null;
      });
      const today = israelDateStrOf(new Date());
      const due = agreement.nextChargeDate ? new Date(agreement.nextChargeDate) : null;
      const preview = !periods ? null : previewStop({
        mode: 'date', stopDay: s.stopDay, today, periods, status: agreement.status,
        dueDay: due && !Number.isNaN(due.getTime()) ? israelDateStrOf(due) : null,
        amount: agreement.amountPerCharge, membershipEnd: await membershipEndDay(agreement.userId),
      });
      if (!preview) {
        outcome = autoStopSkipped('periods_unreadable');
      } else if (!preview.ok) {
        outcome = autoStopSkipped('stop_refused', preview.error);
      } else {
        const nowIso = new Date().toISOString();
        const stop: ForcaScheduledStop = {
          mode: 'date', stopDay: preview.value.stopDay, reason: AUTO_STOP_REASON, parentRequestId: p.requestId,
          by: SYSTEM, byName: AUTO_STOP_REASON, at: nowIso, auto: true,
        };
        const saved = await saveScheduledStop(agreement, stop, { uid: SYSTEM, name: AUTO_STOP_REASON });
        if (saved === 'conflict') {
          outcome = autoStopSkipped('conflict');
        } else {
          const lastActiveDay = preview.value.lastActiveDay ?? addDays(preview.value.stopDay, -1);
          outcome = { result: 'scheduled', stopDay: preview.value.stopDay, lastActiveDay, agreementId: agreement.agreementId };
          console.log(`[forcaCancelRequest] ${p.requestId} auto stop scheduled agreement=${agreement.agreementId} stopDay=${stop.stopDay}`);
          const state = await record(p.requestId, outcome, {
            status: 'end_date_set', endDate: lastActiveDay, agreementId: agreement.agreementId, productName: agreement.productName,
          }).catch((err) => { console.error(`[forcaCancelRequest] ${p.requestId} auto stop set but request not updated:`, err); return null; });
          return { outcome, state };
        }
      }
    }
  } catch (err) {
    console.error(`[forcaCancelRequest] ${p.requestId} auto stop failed:`, err);
    outcome = autoStopSkipped('error');
  }
  const state = await record(p.requestId, outcome).catch((err) => { console.error(`[forcaCancelRequest] ${p.requestId} auto stop outcome not recorded:`, err); return null; });
  return { outcome, state };
}
