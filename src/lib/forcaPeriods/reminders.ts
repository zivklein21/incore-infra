import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { israelDateStrOf } from '../israelTime';
import { getExpoPushToken, sendExpoPush } from '../push';
import { periodsDueForReminder, reminderVars, renderTemplate } from './rules';
import { displayName, listActiveAgreements, loadForcaProfiles, loadPeriodSettings } from './store';

// Daily (forcaPeriodEndReminders, 10:00 Israel): while a period's notice
// window is open (reminderDaysBefore days before its end, up to the end),
// every parent paying for at least one active subscription gets one notice
// per period — an inbox message plus a push — that the period is ending and
// the next one continues unless they ask to stop (terms §5.4).
//
// Once per parent per period: a marker item MEMBER#<payer> /
// PERIODNOTICE#<periodId> is written with a condition before sending, so a
// rerun (or two overlapping runs) never sends twice. One notice names all of
// that parent's children.

export const noticeSk = (periodId: string) => `PERIODNOTICE#${periodId}`;

export async function runPeriodEndReminders(now: Date = new Date()): Promise<{ periods: number; sent: number; alreadySent: number; failed: number }> {
  const settings = await loadPeriodSettings();
  const today = israelDateStrOf(now);
  const due = periodsDueForReminder(settings.periods, today, settings.reminderDaysBefore);
  if (due.length === 0) return { periods: 0, sent: 0, alreadySent: 0, failed: 0 };

  const agreements = await listActiveAgreements();
  const byPayer = new Map<string, string[]>(); // payerUid → trainee uids
  for (const a of agreements) {
    const payer = a.payerUid || a.userId;
    const list = byPayer.get(payer) ?? [];
    if (!list.includes(a.userId)) list.push(a.userId);
    byPayer.set(payer, list);
  }
  const profiles = await loadForcaProfiles([...byPayer.keys(), ...agreements.map((a) => a.userId)]);

  let sent = 0; let alreadySent = 0; let failed = 0;
  for (const { period, next } of due) {
    for (const [payerUid, childUids] of byPayer) {
      const nowIso = now.toISOString();
      try {
        await ddb.send(new PutCommand({
          TableName: FORCA_TABLE_NAME,
          Item: { PK: `MEMBER#${payerUid}`, SK: noticeSk(period.id), periodId: period.id, periodEnd: period.end, sentAt: nowIso },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') { alreadySent++; continue; }
        console.error(`[forcaPeriodEndReminders] marker failed payer=${payerUid} period=${period.id}:`, err);
        failed++;
        continue;
      }
      try {
        const vars = reminderVars(period, next, childUids.map((id) => displayName(profiles.get(id))));
        const title = renderTemplate(settings.reminderTitle, vars);
        const body = renderTemplate(settings.reminderBody, vars);
        await ddb.send(new PutCommand({
          TableName: FORCA_TABLE_NAME,
          Item: {
            PK: `MEMBER#${payerUid}`,
            SK: `MESSAGE#forca_period_end_${period.id}_${nowIso}`,
            type: 'admin_alert',
            title,
            body,
            createdAt: nowIso,
            requiresAction: false,
            read: false,
          },
        }));
        const payer = profiles.get(payerUid);
        const token = payer ? getExpoPushToken(payer) : null;
        if (token) await sendExpoPush(token, title, body, { screen: 'ForcaTabs', initialTab: 'profile' });
        sent++;
      } catch (err) {
        // The marker stays: a half-sent notice isn't retried into a duplicate.
        console.error(`[forcaPeriodEndReminders] send failed payer=${payerUid} period=${period.id}:`, err);
        failed++;
      }
    }
  }
  return { periods: due.length, sent, alreadySent, failed };
}
