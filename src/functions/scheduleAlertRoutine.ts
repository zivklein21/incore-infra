// EventBridge Scheduled Rule — unix-cron "*/10 * * * *" (every 10 min),
// Asia/Jerusalem. See functions/src/notificationTiming.ts for the timing
// rationale. Fires the configured template once per matching weekday/time —
// a one-off, different-time send is a manual "Send Now" action from the
// admin screen (triggerTemplateAlert.ts), not a standing schedule.
import { getScheduleAlertSettings, patchScheduleAlertSettings } from '../lib/notificationTiming';
import { sendTemplateBroadcast } from '../lib/templateBroadcast';
import { israelHour, israelMinute, israelWeekday, israelDateStrOf } from '../lib/israelTime';

const TICK_MINUTES = 10;

export async function handler(): Promise<void> {
  const settings = await getScheduleAlertSettings();
  if (!settings.enabled || !settings.templateId) return;
  if (israelWeekday(new Date()) !== settings.weekday) return;

  const now = new Date();
  const todayStr = israelDateStrOf(now);
  const nowMinutesOfDay = israelHour(now) * 60 + israelMinute(now);
  const targetMinutesOfDay = settings.hour * 60 + settings.minute;
  const sentKey = `weekly_${todayStr}`;

  if (settings.lastSentKey === sentKey) return;
  if (nowMinutesOfDay < targetMinutesOfDay || nowMinutesOfDay >= targetMinutesOfDay + TICK_MINUTES) return;

  console.log(`[scheduleAlertRoutine] firing ${sentKey}`);

  const result = await sendTemplateBroadcast(settings.templateId, {}, 'system:scheduleAlertRoutine');
  await patchScheduleAlertSettings({ lastSentKey: sentKey });

  console.log(`[scheduleAlertRoutine] done — success=${result.success} dispatched=${result.dispatchedCount}`);
}
