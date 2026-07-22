// EventBridge Scheduled Rule — unix-cron "0 3 * * *" (03:00 daily),
// Asia/Jerusalem. See src/lib/hypBillingAgreements.ts for the full logic,
// shared with adminRunHypBillingCycle.ts / adminChargeHypAgreementNow.ts.
import { runHypBillingCycle } from '../lib/hypBillingAgreements';

export async function handler(): Promise<void> {
  await runHypBillingCycle();
}
