import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';

// PK='APPCONFIG' SK='NOTIFICATION_TIMING' — see saveSupportSettings.ts /
// getSupportSettings.ts for the same "one item per config type under a
// shared PK" convention.
const CONFIG_KEY = { PK: 'APPCONFIG', SK: 'NOTIFICATION_TIMING' };

export interface ReminderSettings {
  hoursBefore: number;
  windowStartHour: number;
  windowEndHour: number;
}

export interface ScheduleAlertSettings {
  enabled: boolean;
  templateId: string | null;
  mode: 'weekly' | 'once';
  weekday: number;
  hour: number;
  minute: number;
  onceDate: string | null;
  onceHour: number;
  onceMinute: number;
  lastSentKey: string | null;
}

const REMINDER_DEFAULTS: ReminderSettings = { hoursBefore: 2, windowStartHour: 6, windowEndHour: 20 };

const SCHEDULE_ALERT_DEFAULTS: ScheduleAlertSettings = {
  enabled: false, templateId: null, mode: 'weekly', weekday: 6, hour: 20, minute: 0,
  onceDate: null, onceHour: 20, onceMinute: 0, lastSentKey: null,
};

async function getSettingsItem(): Promise<Record<string, unknown>> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: CONFIG_KEY }));
  return res.Item ?? {};
}

export async function getReminderSettings(): Promise<ReminderSettings> {
  const d = (await getSettingsItem()).reminder as Partial<ReminderSettings> | undefined;
  return {
    hoursBefore: typeof d?.hoursBefore === 'number' ? d.hoursBefore : REMINDER_DEFAULTS.hoursBefore,
    windowStartHour: typeof d?.windowStartHour === 'number' ? d.windowStartHour : REMINDER_DEFAULTS.windowStartHour,
    windowEndHour: typeof d?.windowEndHour === 'number' ? d.windowEndHour : REMINDER_DEFAULTS.windowEndHour,
  };
}

export async function getScheduleAlertSettings(): Promise<ScheduleAlertSettings> {
  const d = (await getSettingsItem()).scheduleAlert as Partial<ScheduleAlertSettings> | undefined;
  return {
    enabled: typeof d?.enabled === 'boolean' ? d.enabled : SCHEDULE_ALERT_DEFAULTS.enabled,
    templateId: typeof d?.templateId === 'string' ? d.templateId : SCHEDULE_ALERT_DEFAULTS.templateId,
    mode: d?.mode === 'once' ? 'once' : 'weekly',
    weekday: typeof d?.weekday === 'number' ? d.weekday : SCHEDULE_ALERT_DEFAULTS.weekday,
    hour: typeof d?.hour === 'number' ? d.hour : SCHEDULE_ALERT_DEFAULTS.hour,
    minute: typeof d?.minute === 'number' ? d.minute : SCHEDULE_ALERT_DEFAULTS.minute,
    onceDate: typeof d?.onceDate === 'string' ? d.onceDate : SCHEDULE_ALERT_DEFAULTS.onceDate,
    onceHour: typeof d?.onceHour === 'number' ? d.onceHour : SCHEDULE_ALERT_DEFAULTS.onceHour,
    onceMinute: typeof d?.onceMinute === 'number' ? d.onceMinute : SCHEDULE_ALERT_DEFAULTS.onceMinute,
    lastSentKey: typeof d?.lastSentKey === 'string' ? d.lastSentKey : SCHEDULE_ALERT_DEFAULTS.lastSentKey,
  };
}

export async function patchScheduleAlertSettings(patch: Record<string, unknown>): Promise<void> {
  const current = (await getSettingsItem()).scheduleAlert as Record<string, unknown> | undefined;
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: CONFIG_KEY,
    UpdateExpression: 'SET scheduleAlert = :v',
    ExpressionAttributeValues: { ':v': { ...current, ...patch } },
  }));
}
