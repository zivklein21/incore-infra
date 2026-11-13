import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { israelDateStrOf } from '../israelTime';
import {
  activityStatus, currentPeriodEnd, periodsWithoutNext, previewPeriodChange, REMINDER_VARIABLES,
  validatePeriods, validateReminder, type PreviewAgreement,
} from './rules';
import { displayName, listActiveAgreements, loadForcaProfiles, loadPeriodSettings, savePeriodSettings } from './store';

// FORCA activity periods — three routes on the shared integration (incoreWorkoutApi.ts):
//   GET  adminListForcaPeriods    admin: periods, reminder settings, today's status, warnings
//   POST adminSaveForcaPeriods    admin: { periods, reminderDaysBefore, reminderTitle, reminderBody, version, dryRun }
//                                 dryRun → only the preview of which upcoming charges move; else save (+ the same preview)
//   GET  getForcaActivityStatus   any signed-in user: in a period today?, next period, the "אין פעילות" label,
//                                 and the current period's end (the cancel screen's exit point)
// All new routes; nothing an existing build calls changes.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

const today = () => israelDateStrOf(new Date());

function parseBody(event: Event): Record<string, unknown> | null {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function adminListForcaPeriods(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const settings = await loadPeriodSettings();
  const day = today();
  return json(200, {
    periods: settings.periods,
    reminderDaysBefore: settings.reminderDaysBefore,
    reminderTitle: settings.reminderTitle,
    reminderBody: settings.reminderBody,
    reminderVariables: REMINDER_VARIABLES,
    version: settings.version,
    updatedAt: settings.updatedAt ?? null,
    today: day,
    status: activityStatus(settings.periods, day),
    // Their end-of-period notice won't go out: it would promise a next period that doesn't exist.
    noNextPeriod: periodsWithoutNext(settings.periods, day).map((p) => p.id),
  });
}

export async function adminSaveForcaPeriods(event: Event): Promise<Result> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_body' });

  const current = await loadPeriodSettings();
  if (typeof body.version !== 'number' || body.version !== current.version) {
    return json(409, { error: 'stale_version', version: current.version });
  }
  const periods = validatePeriods(body.periods, randomUUID);
  if (!periods.ok) return json(400, { error: periods.error, detail: periods.detail ?? null });
  const reminder = validateReminder(body, current);
  if (!reminder.ok) return json(400, { error: reminder.error });

  const day = today();
  const agreements = await listActiveAgreements();
  const profiles = await loadForcaProfiles(agreements.map((a) => a.userId));
  const previewInput: PreviewAgreement[] = agreements.filter((a) => a.nextChargeDate).map((a) => ({
    agreementId: a.agreementId,
    dueDay: israelDateStrOf(new Date(a.nextChargeDate!)),
    amount: a.amountPerCharge,
    childName: displayName(profiles.get(a.userId), a.groupName),
    payerName: a.payerName,
    productName: a.productName,
  }));
  const preview = previewPeriodChange(current.periods, periods.value, previewInput, day);

  if (body.dryRun === true) return json(200, { dryRun: true, preview });

  try {
    const saved = await savePeriodSettings({
      periods: periods.value,
      ...reminder.value,
      updatedAt: new Date().toISOString(),
      updatedBy: uid,
    }, current.version);
    console.log(`[adminSaveForcaPeriods] by=${uid} version=${saved.version} periods=${saved.periods.length} changedCharges=${preview.changes.length}`);
    return json(200, { saved: true, version: saved.version, periods: saved.periods, preview });
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return json(409, { error: 'stale_version' });
    throw err;
  }
}

export async function getForcaActivityStatus(): Promise<Result> {
  const settings = await loadPeriodSettings();
  const day = today();
  return json(200, {
    today: day,
    ...activityStatus(settings.periods, day),
    currentPeriodEnd: currentPeriodEnd(settings.periods, day),
  });
}
