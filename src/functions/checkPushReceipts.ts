import { checkPushReceipts } from '../lib/push';

// EventBridge Scheduled Rule — every 30 minutes, Asia/Jerusalem.
// Fetches Expo push receipts for tickets sent 15+ minutes ago, logs every
// delivery error and drops tokens of uninstalled apps — see lib/push.ts.
export async function handler(): Promise<void> {
  const summary = await checkPushReceipts();
  console.log(`[checkPushReceipts] checked=${summary.checked} ok=${summary.ok} errors=${summary.errors} pending=${summary.pending}`);
}
