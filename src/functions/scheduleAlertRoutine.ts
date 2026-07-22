// EventBridge Scheduled Rule — unix-cron "*/10 * * * *" (every 10 min),
// Asia/Jerusalem. See functions/src/notificationTiming.ts for the full
// weekly/one-off timing rationale.
import { getScheduleAlertSettings, patchScheduleAlertSettings } from '../lib/notificationTiming';
import { sendTemplateBroadcast } from '../lib/templateBroadcast';
import { israelHour, israelMinute, israelWeekday, israelDateStrOf } from '../lib/israelTime';

const TICK_MINUTES = 10;

export async function handler(): Promise<void> {
  const settings = await getScheduleAlertSettings();
  if (!settings.enabled || !settings.templateId) return;

  const now = new Date();
  const todayStr = israelDateStrOf(now);
  const nowHour = israelHour(now);
  const nowMinute = israelMinute(now);
  const nowMinutesOfDay = nowHour * 60 + nowMinute;

  let targetMinutesOfDay: number | null = null;
  let sentKey: string | null = null;
  let isOnceOverride = false;

  if (settings.onceDate) {
    if (settings.onceDate === todayStr) {
      targetMinutesOfDay = settings.onceHour * 60 + settings.onceMinute;
      sentKey = `once_${settings.onceDate}`;
      isOnceOverride = true;
    } else if (settings.onceDate < todayStr) {
      // Its date has passed without firing — clear it so the weekly rule
      // resumes instead of sitting there stale forever.
      await patchScheduleAlertSettings({ onceDate: null });
    }
  }

  if (targetMinutesOfDay === null && israelWeekday(now) === settings.weekday) {
    targetMinutesOfDay = settings.hour * 60 + settings.minute;
    sentKey = `weekly_${todayStr}`;
  }

  if (targetMinutesOfDay === null || sentKey === null) return;
  if (settings.lastSentKey === sentKey) return;
  if (nowMinutesOfDay < targetMinutesOfDay || nowMinutesOfDay >= targetMinutesOfDay + TICK_MINUTES) return;

  console.log(`[scheduleAlertRoutine] firing ${sentKey} (${isOnceOverride ? 'one-off override' : 'weekly'})`);

  const result = await sendTemplateBroadcast(settings.templateId, {}, 'system:scheduleAlertRoutine');

  const update: Record<string, unknown> = { lastSentKey: sentKey };
  if (isOnceOverride) update.onceDate = null;
  await patchScheduleAlertSettings(update);

  console.log(`[scheduleAlertRoutine] done — success=${result.success} dispatched=${result.dispatchedCount}`);
}
