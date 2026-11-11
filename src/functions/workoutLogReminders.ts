// EventBridge Scheduler: every 15 minutes, Asia/Jerusalem. INCORE "log your
// workout" push after a class ends; see src/lib/workoutLogReminder.ts.
import { runWorkoutLogReminders } from '../lib/workoutLogReminder';

export async function handler(): Promise<void> {
  const result = await runWorkoutLogReminders();
  console.log('[workoutLogReminders] done', JSON.stringify(result));
}
