import type { MemberProfileItem } from './entities';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export function getExpoPushToken(profile: MemberProfileItem): string | null {
  const raw = profile.device?.expo_push_token ?? profile.device?.expoPushToken ?? profile.expoPushToken ?? '';
  return raw.startsWith('ExponentPushToken') ? raw : null;
}

export async function sendExpoPush(token: string, title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: token, title, body, sound: 'default', ...(data ? { data } : {}) }),
    });
  } catch (err: any) {
    console.error('[push] send failed:', err);
  }
}
