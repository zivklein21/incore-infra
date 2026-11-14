// EventBridge Scheduled Rule — unix-cron "0 5 * * *" (05:00 daily),
// Asia/Jerusalem — after the FORCA charge run at 03:30.
// FORCA medical freeze: refunds each frozen month once its charge exists
// (lib/forcaMedicalFreeze/store.ts runDueFreezeRefunds). A separate job so the
// charge job itself never changes: the monthly charge is always the full amount.
import { runDueFreezeRefunds } from '../lib/forcaMedicalFreeze/store';

export async function handler(): Promise<void> {
  await runDueFreezeRefunds();
}
