import { TRAINEE_EQUIPMENT_ITEM_MAX, TRAINEE_EQUIPMENT_MAX_ITEMS } from './sessionInfo/saveSessionTraineeInfo';

// Text details of a FORCA special activity (Manage → Activities) — shared by
// adminCreateActivity.ts and adminUpdateSessionInstance.ts. Forms attached to
// the activity show them (formTemplates/activityFields.ts).

export const ACTIVITY_TEXT_MAX = { className: 120, description: 2000, transport: 1000, safetyNotes: 2000 } as const;
export type ActivityTextField = keyof typeof ACTIVITY_TEXT_MAX;
export const ACTIVITY_TEXT_FIELDS = Object.keys(ACTIVITY_TEXT_MAX) as ActivityTextField[];

/** undefined = not sent (leave as is); '' = clear; otherwise the trimmed, capped text. */
export function cleanActivityText(v: unknown, field: ActivityTextField): string | undefined {
  if (v === null) return '';
  if (typeof v !== 'string') return undefined;
  return v.trim().slice(0, ACTIVITY_TEXT_MAX[field]);
}

/** A "what to bring" list: trimmed, capped items; null when it's not a list or too long. */
export function cleanEquipmentList(v: unknown): string[] | null {
  if (v === null) return [];
  if (!Array.isArray(v)) return null;
  const items = v.filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, TRAINEE_EQUIPMENT_ITEM_MAX)).filter(Boolean);
  return items.length > TRAINEE_EQUIPMENT_MAX_ITEMS ? null : items;
}
