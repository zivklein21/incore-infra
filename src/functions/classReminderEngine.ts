// EventBridge Scheduled Rule — unix-cron "0 * * * *" (top of every hour),
// Asia/Jerusalem. See src/lib/classReminderEngine.ts for the full logic,
// shared with testClassReminder.ts.
import { runClassReminderEngine } from '../lib/classReminderEngine';

export async function handler(): Promise<void> {
  const result = await runClassReminderEngine();
  console.log('[classReminderEngine] done', JSON.stringify(result));
}
