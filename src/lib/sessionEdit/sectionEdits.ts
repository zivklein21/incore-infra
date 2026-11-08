import { randomUUID } from 'crypto';
import type { WorkoutPlanBlockItem, WorkoutPlanStation } from '../entities';

// What a coach may change in one section of a session's plan. Deliberately
// has no label, mode, order, locked, or equipment fields: the plan's top-level
// structure can't be touched from here, whatever a client sends.
export interface SectionEdit {
  id: string;
  timeMethod?: string;
  coachGuidelines?: string;
  stations?: StationRowEdit[];
  freeTextItems?: string[];
}

export interface StationRowEdit {
  /** Absent on a line the coach added. */
  id?: string;
  name?: string;
  text?: string;
  notes?: string;
}

const LINE_MAX = 500;
const GUIDELINES_MAX = 2000;
const ROWS_MAX = 60;

type Block = WorkoutPlanBlockItem;

export const blockId = (b: Pick<Block, 'SK'>): string => b.SK.replace('BLOCK#', '');

/** A station's one displayed line. Same join WorkoutPlanDetailView.tsx renders. */
export function stationText(st: Pick<WorkoutPlanStation, 'exerciseNames' | 'freeTextExercise'>): string {
  return (st.exerciseNames ?? []).length > 0 ? st.exerciseNames.join(' / ') : (st.freeTextExercise ?? '');
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

export function parseSectionEdits(raw: unknown): { ok: true; sections: SectionEdit[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_sections' };
  const sections: SectionEdit[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'invalid_sections' };
    const s = entry as Record<string, unknown>;
    const id = text(s.id);
    if (!id) return { ok: false, error: 'invalid_sections' };
    const section: SectionEdit = { id, timeMethod: text(s.timeMethod), coachGuidelines: text(s.coachGuidelines) };
    if ((section.timeMethod?.length ?? 0) > LINE_MAX || (section.coachGuidelines?.length ?? 0) > GUIDELINES_MAX) {
      return { ok: false, error: 'text_too_long' };
    }
    if (s.stations !== undefined) {
      if (!Array.isArray(s.stations) || s.stations.length > ROWS_MAX) return { ok: false, error: 'invalid_stations' };
      section.stations = [];
      for (const row of s.stations as unknown[]) {
        if (!row || typeof row !== 'object') return { ok: false, error: 'invalid_stations' };
        const r = row as Record<string, unknown>;
        const edit: StationRowEdit = { id: text(r.id) || undefined, name: text(r.name) ?? '', text: text(r.text) ?? '', notes: text(r.notes) ?? '' };
        if ([edit.name, edit.text, edit.notes].some((v) => (v?.length ?? 0) > LINE_MAX)) return { ok: false, error: 'text_too_long' };
        section.stations.push(edit);
      }
    }
    if (s.freeTextItems !== undefined) {
      if (!Array.isArray(s.freeTextItems) || s.freeTextItems.length > ROWS_MAX) return { ok: false, error: 'invalid_free_text' };
      section.freeTextItems = (s.freeTextItems as unknown[]).map(text).filter((v): v is string => !!v);
      if (section.freeTextItems.some((v) => v.length > LINE_MAX)) return { ok: false, error: 'text_too_long' };
    }
    sections.push(section);
  }
  return { ok: true, sections };
}

function applyStationRows(block: Block, rows: StationRowEdit[]): WorkoutPlanStation[] {
  const byId = new Map((block.stations ?? []).map((st) => [st.id, st]));
  const stations: WorkoutPlanStation[] = [];
  for (const row of rows) {
    const line = row.text ?? '';
    // A row emptied of everything is a deleted row.
    if (!line && !row.name && !row.notes) continue;
    const existing = row.id ? byId.get(row.id) : undefined;
    // An unchanged line keeps its catalog link, so measurable logging and
    // plan-derived equipment keep working. A rewritten one is free text from
    // here on: there's no exercise left to log against.
    const keepsLink = !!existing && line === stationText(existing).trim() && existing.exerciseIds.length > 0;
    stations.push({
      id: existing?.id ?? randomUUID(),
      order: stations.length,
      exerciseIds: keepsLink ? existing!.exerciseIds : [],
      exerciseNames: keepsLink ? existing!.exerciseNames : [],
      ...(row.name ? { name: row.name } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(!keepsLink && line ? { freeTextExercise: line } : {}),
      ...(keepsLink && existing!.measurable ? { measurable: true } : {}),
    });
  }
  return stations;
}

const setOrClear = <K extends keyof Block>(block: Block, key: K, value: Block[K] | undefined | '') => {
  if (value === undefined || value === '') delete block[key];
  else block[key] = value;
};

// What makes two versions of a block "the same" to a reader. Field-by-field
// rather than a whole-item compare: stored key order and untouched attributes
// mustn't turn a no-op save into a phantom override.
function fingerprint(b: Block): string {
  return JSON.stringify([
    b.timeMethod ?? '', b.coachGuidelines ?? '', b.freeTextItems ?? [],
    (b.stations ?? []).map((st) => [st.id, st.name ?? '', st.notes ?? '', stationText(st), st.exerciseIds, st.measurable === true]),
  ]);
}

/**
 * `blocks` in display order. The edit must name exactly those sections in
 * exactly that order: a stale client (template gained a section since the
 * screen opened) or a crafted one is refused, never merged.
 */
export function applySectionEdits(
  blocks: Block[],
  edits: SectionEdit[],
): { ok: true; blocks: Block[]; changed: Block[] } | { ok: false; error: 'structure_changed' } {
  if (edits.length !== blocks.length || edits.some((e, i) => e.id !== blockId(blocks[i]))) {
    return { ok: false, error: 'structure_changed' };
  }
  const usesStations = (b: Block) => b.mode === 'stations' || b.mode === 'sequentialRoute' || b.mode === 'strength';
  const changed: Block[] = [];
  const next = blocks.map((block, i) => {
    const edit = edits[i];
    const updated: Block = { ...block };
    if (edit.timeMethod !== undefined) setOrClear(updated, 'timeMethod', edit.timeMethod);
    if (edit.coachGuidelines !== undefined) setOrClear(updated, 'coachGuidelines', edit.coachGuidelines);
    if (usesStations(block) && edit.stations) {
      const stations = applyStationRows(block, edit.stations);
      setOrClear(updated, 'stations', stations.length > 0 ? stations : undefined);
      const measurable = (block.mode === 'stations' || block.mode === 'strength') && stations.some((st) => st.measurable === true);
      setOrClear(updated, 'measurable', measurable ? true : undefined);
    }
    if (block.mode === 'freeText' && edit.freeTextItems) {
      setOrClear(updated, 'freeTextItems', edit.freeTextItems.length > 0 ? edit.freeTextItems : undefined);
    }
    if (fingerprint(updated) !== fingerprint(block)) changed.push(updated);
    return updated;
  });
  return { ok: true, blocks: next, changed };
}
