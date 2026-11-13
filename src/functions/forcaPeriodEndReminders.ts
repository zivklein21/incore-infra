// EventBridge Scheduler: 10:00 daily, Asia/Jerusalem. FORCA "the activity
// period is ending, the next one continues" notice to parents with an
// active subscription. See src/lib/forcaPeriods/reminders.ts.
import { runPeriodEndReminders } from '../lib/forcaPeriods/reminders';

export async function handler(): Promise<void> {
  const result = await runPeriodEndReminders();
  console.log('[forcaPeriodEndReminders] done', JSON.stringify(result));
}
