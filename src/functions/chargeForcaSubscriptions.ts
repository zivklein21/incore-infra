// EventBridge Scheduled Rule — unix-cron "30 3 * * *" (03:30 daily),
// Asia/Jerusalem — staggered 30 minutes after chargeHypBillingAgreements'
// own 03:00 run. See src/lib/forcaBillingAgreements.ts for the full logic.
import { runForcaBillingCycle } from '../lib/forcaBillingAgreements';

export async function handler(): Promise<void> {
  await runForcaBillingCycle();
}
