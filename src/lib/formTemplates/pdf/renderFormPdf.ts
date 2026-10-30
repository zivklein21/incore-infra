import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, PDFImage, PDFPage, rgb, RGB, StandardFonts } from 'pdf-lib';
import { NOTO_SANS_HEBREW_TTF_BASE64 } from './notoSansHebrew';
import { drawLine, Fonts, lineWidth, plain, StyledChar, wrapLine } from './rtlText';
import { parseInline, parseRichText, Span } from '../richText';
import { DISPLAY_ONLY, hebrewLetter, sectionNumbers, SignerRole, TemplateField, TemplateSection } from '../schema';
import { Answers, detailsKey, visibleIds } from '../logic';

// The signed copy of a FORCA form (and the "Preview PDF" sample): every
// section with its exact numbering and text FROM THE SIGNED VERSION, every
// field value, each declaration marked checked, each signature with its
// server-recorded date/time (DD/MM/YYYY HH:mm, Asia/Jerusalem), then an
// audit page, with "עמוד X מתוך Y" in every footer.
//
// Drawn directly with pdf-lib (no headless browser), the same way
// incore-site renders its Hebrew PDFs — rtlText.ts does the RTL layout.
// Hebrew is Noto Sans Hebrew (embedded, subset), Latin is Helvetica.

export interface SignatureRecord {
  fieldId: string;
  role: SignerRole;
  userId: string;
  name: string;
  paths: string[];
  /** Server time, ISO UTC. */
  signedAt: string;
  ip: string;
  userAgent: string;
  deviceId: string;
  version: number;
}

export interface AcknowledgmentRecord { role: SignerRole; userId: string; name: string; at: string; ip: string; userAgent: string; deviceId: string; version: number }

export interface FormPdfInput {
  title: string;
  code: string;
  version: number;
  sections: TemplateSection[];
  answers: Answers;
  signatures: SignatureRecord[];
  acknowledgments?: AcknowledgmentRecord[];
  submissionId: string;
  childName: string;
  generatedAt: Date;
  /** "Preview PDF": dummy data + SAMPLE watermark. */
  sample?: boolean;
  /** PNG bytes of the white-on-pink FORCA wordmark (optional — falls back to text). */
  logoPng?: Uint8Array | null;
}

const A4: [number, number] = [595.28, 841.89];
const M = 48; // page margin
const BRAND = rgb(0x7a / 255, 0x00 / 255, 0x4b / 255); // colors.forcaDarkPink
const BRAND_LIGHT = rgb(1, 0xc2 / 255, 0xe8 / 255);
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.42, 0.42, 0.46);
const LINE = rgb(0.85, 0.85, 0.88);
const SURFACE = rgb(0.96, 0.96, 0.97);

export const ROLE_HE: Record<SignerRole, string> = { parent: 'הורה', trainee: 'מתאמנת' };

/** DD/MM/YYYY HH:mm in Israel time. */
export function israelDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

const displayDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

const fromSpans = (spans: Span[]): StyledChar[] => spans.flatMap(s => plain(s.text, { bold: s.bold, underline: s.underline }));

/** Signature strokes ("M x,y L x,y …") → one path moved to (0,0) and scaled to fit w×h. */
export function fitSignature(paths: string[], w: number, h: number): { d: string; scale: number; width: number; height: number } | null {
  const pts = paths.flatMap(p => [...p.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])]));
  if (!pts.length) return null;
  const minX = Math.min(...pts.map(p => p[0])); const maxX = Math.max(...pts.map(p => p[0]));
  const minY = Math.min(...pts.map(p => p[1])); const maxY = Math.max(...pts.map(p => p[1]));
  const bw = Math.max(maxX - minX, 1); const bh = Math.max(maxY - minY, 1);
  const scale = Math.min(w / bw, h / bh, 1.5);
  const d = paths.map(p => p.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${(Number(x) - minX).toFixed(1)},${(Number(y) - minY).toFixed(1)}`)).join(' ');
  return { d, scale, width: bw * scale, height: bh * scale };
}

/** Dummy answers for "Preview PDF" — every field filled with something plausible. */
export function sampleAnswers(sections: TemplateSection[]): Answers {
  const a: Answers = {};
  for (const f of sections.flatMap(s => s.fields)) {
    switch (f.type) {
      case 'short_text': a[f.id] = 'טקסט לדוגמה'; break;
      case 'long_text': a[f.id] = 'תשובה ארוכה לדוגמה, כולל English words ומספרים 123.'; break;
      case 'number': a[f.id] = '12'; break;
      case 'date': a[f.id] = new Date().toISOString().slice(0, 10); break;
      case 'time': a[f.id] = '17:30'; break;
      case 'israeli_id': a[f.id] = '000000018'; break;
      case 'phone': a[f.id] = '050-0000000'; break;
      case 'email': a[f.id] = 'sample@example.com'; break;
      case 'single_select': case 'dropdown': a[f.id] = f.options?.[0]?.id; break;
      case 'multi_select': a[f.id] = (f.options ?? []).slice(0, 2).map(o => o.id); break;
      case 'yes_no': a[f.id] = 'yes'; if (f.detailsLabel) a[detailsKey(f.id)] = 'פירוט לדוגמה'; break;
      case 'checkbox': a[f.id] = true; break;
      case 'file': a[f.id] = { name: 'document.pdf' }; break;
      case 'signoff_list': a[f.id] = (f.items ?? []).map(i => i.id); break;
      default: break;
    }
  }
  return a;
}

const SAMPLE_STROKE = ['M10,40 L20,20 L30,45 L42,15 L55,42 L70,22 L85,38 L100,25 L120,35'];

export function formatAnswer(field: TemplateField, answer: Answers[string]): string {
  if (answer === undefined || answer === null || answer === '') return '—';
  switch (field.type) {
    case 'date': return displayDate(String(answer));
    case 'single_select': case 'dropdown': return field.options?.find(o => o.id === answer)?.label ?? String(answer);
    case 'multi_select': return Array.isArray(answer) ? answer.map(id => field.options?.find(o => o.id === id)?.label ?? id).join(', ') : '—';
    case 'yes_no': return answer === 'yes' ? 'כן' : answer === 'no' ? 'לא' : '—';
    case 'file': return typeof answer === 'object' && 'name' in answer ? answer.name : '—';
    default: return typeof answer === 'string' ? answer : String(answer);
  }
}

class Writer {
  doc: PDFDocument;
  fonts: Fonts;
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(doc: PDFDocument, fonts: Fonts, private continuationTitle: string) {
    this.doc = doc;
    this.fonts = fonts;
  }
  get right() { return A4[0] - M; }
  get width() { return A4[0] - 2 * M; }

  newPage(first = false) {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - M;
    if (!first) {
      drawLine(this.page, plain(this.continuationTitle), this.fonts, { right: this.right, y: A4[1] - 30, size: 8, color: MUTED });
      this.page.drawLine({ start: { x: M, y: A4[1] - 36 }, end: { x: A4[0] - M, y: A4[1] - 36 }, thickness: 0.5, color: LINE });
      this.y = A4[1] - 56;
    }
  }
  ensure(h: number) { if (this.y - h < M + 24) this.newPage(); }

  /** Wrapped RTL text block; returns height used. */
  text(chars: StyledChar[], opts: { size?: number; color?: RGB; indent?: number; gap?: number; maxWidth?: number } = {}) {
    const size = opts.size ?? 10.5;
    const lead = size * 1.45;
    const right = this.right - (opts.indent ?? 0);
    const lines = wrapLine(chars, this.fonts, size, opts.maxWidth ?? this.width - (opts.indent ?? 0));
    for (const line of lines) {
      this.ensure(lead);
      drawLine(this.page, line, this.fonts, { right, y: this.y - size, size, color: opts.color ?? INK });
      this.y -= lead;
    }
    this.y -= opts.gap ?? 0;
  }

  /** A small square on the reading-start (right) side, ticked or empty, with text beside it. */
  checkRow(label: StyledChar[], checked: boolean, indent = 0, size = 10.5) {
    const box = 9;
    const lines = wrapLine(label, this.fonts, size, this.width - indent - box - 8);
    this.ensure(size * 1.45 * lines.length + 4);
    const right = this.right - indent;
    const top = this.y;
    this.page.drawRectangle({ x: right - box, y: top - size - 1, width: box, height: box, borderColor: checked ? BRAND : MUTED, borderWidth: 1, color: checked ? BRAND_LIGHT : undefined });
    if (checked) this.page.drawSvgPath('M1.5,4.5 L3.8,7 L8,1.5', { x: right - box, y: top - size + box - 1, borderColor: BRAND, borderWidth: 1.4 });
    for (const line of lines) {
      drawLine(this.page, line, this.fonts, { right: right - box - 6, y: this.y - size, size, color: INK });
      this.y -= size * 1.45;
    }
    this.y -= 3;
  }

  rule(indent = 0) {
    this.ensure(12);
    this.y -= 5;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: this.right - indent, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 7;
  }
}

export async function renderFormPdf(input: FormPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts: Fonts = {
    he: await doc.embedFont(Buffer.from(NOTO_SANS_HEBREW_TTF_BASE64, 'base64'), { subset: true }),
    latin: await doc.embedFont(StandardFonts.Helvetica),
    latinBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  let logo: PDFImage | null = null;
  if (input.logoPng) {
    try { logo = await doc.embedPng(input.logoPng); } catch { logo = null; }
  }
  const versionLine = `${input.code ? `${input.code} · ` : ''}גרסה ${input.version}`;
  const w = new Writer(doc, fonts, `${input.title} · ${versionLine}`);
  const answers = input.sample ? { ...sampleAnswers(input.sections), ...input.answers } : input.answers;
  const visible = input.sample
    ? new Set([...input.sections.map(s => s.id), ...input.sections.flatMap(s => s.fields.map(f => f.id))])
    : visibleIds(input.sections, answers);
  const numbers = sectionNumbers(input.sections);

  // ── Header ──
  w.newPage(true);
  const stripH = 64;
  w.page.drawRectangle({ x: 0, y: A4[1] - stripH, width: A4[0], height: stripH, color: BRAND });
  if (logo) {
    const h = 30;
    const lw = (logo.width / logo.height) * h;
    w.page.drawImage(logo, { x: M, y: A4[1] - stripH / 2 - h / 2, width: lw, height: h });
  } else {
    w.page.drawText('FORCA', { x: M, y: A4[1] - stripH / 2 - 7, size: 20, font: fonts.latinBold, color: rgb(1, 1, 1) });
  }
  drawLine(w.page, plain(input.title, { bold: true }), fonts, { right: w.right, y: A4[1] - 32, size: 16, color: rgb(1, 1, 1) });
  drawLine(w.page, plain(versionLine), fonts, { right: w.right, y: A4[1] - 50, size: 9, color: BRAND_LIGHT });
  w.y = A4[1] - stripH - 22;
  w.text(plain(`שם המתאמנת: ${input.childName || '—'}`), { size: 10, color: MUTED });
  w.text(plain(`מזהה הגשה: ${input.submissionId}`), { size: 8.5, color: MUTED, gap: 8 });

  const sigByField = new Map(input.signatures.map(s => [s.fieldId, s]));

  // ── Body ──
  const sectionDepth = new Map<string, number>();
  for (let section of input.sections) {
    const depth = section.parentId ? (sectionDepth.get(section.parentId) ?? 0) + 1 : 0;
    sectionDepth.set(section.id, depth);
    if (!visible.has(section.id)) continue;
    const indent = Math.min(depth, 5) * 14;
    const number = numbers.get(section.id);
    const titleSize = depth === 0 ? 13 : depth === 1 ? 11.5 : 10.5;
    // The details box (name, ID…) has no number; it gets a default title and a rule under it.
    if (section.details && !section.title.trim()) section = { ...section, title: 'פרטים' };
    if (number || section.title.trim()) {
      w.ensure(titleSize * 3);
      w.y -= depth === 0 ? 8 : 4;
      const heading = [...(number ? plain(`${number}. `, { bold: true }) : []), ...fromSpans(parseInline(section.title)).map(c => ({ ...c, bold: true }))];
      w.text(heading, { size: titleSize, color: depth === 0 ? BRAND : INK, indent, gap: 2 });
    }
    if (section.description?.trim()) {
      for (const block of parseRichText(section.description)) {
        const chars = fromSpans(block.spans);
        if (block.kind === 'p') {
          if (!chars.length) { w.y -= 5; continue; }
          w.text(chars, { indent });
        } else {
          const marker = block.kind === 'bullet' ? '•' : block.marker;
          // Multi-level numbers (1.1. / 1.1.1.) step in one level each and need a wider marker column.
          const level = block.kind === 'number' ? (block.depth - 1) * 14 : 0;
          const markerWidth = Math.max(14, lineWidth(plain(marker), fonts, 10.5) + 5);
          w.ensure(16);
          drawLine(w.page, plain(marker), fonts, { right: w.right - indent - level, y: w.y - 10.5, size: 10.5, color: INK });
          w.text(chars, { indent: indent + level + markerWidth });
        }
      }
      w.y -= 3;
    }
    (section.items ?? []).forEach((item, i) => {
      w.ensure(16);
      drawLine(w.page, plain(`${hebrewLetter(i)}.`), fonts, { right: w.right - indent - 4, y: w.y - 10.5, size: 10.5, color: INK });
      w.text(fromSpans(parseInline(item.text)), { indent: indent + 20 });
    });

    // Fields (nested ones indented under their parent).
    const fieldDepth = new Map<string, number>();
    for (const f of section.fields) {
      const fd = f.parentId ? (fieldDepth.get(f.parentId) ?? 0) + 1 : 0;
      fieldDepth.set(f.id, fd);
      if (!visible.has(f.id)) continue;
      const fi = indent + fd * 14;
      const answer = answers[f.id];
      switch (f.type) {
        case 'page_break': w.newPage(); break;
        case 'divider': w.rule(fi); break;
        case 'section_header': w.y -= 3; w.text(fromSpans(parseInline(f.label)).map(c => ({ ...c, bold: true })), { size: 11, indent: fi, gap: 2 }); break;
        case 'info_text': {
          const lines = wrapLine(fromSpans(parseInline(f.label)), fonts, 10, w.width - fi - 16);
          const h = lines.length * 14.5 + 10;
          w.ensure(h);
          w.page.drawRectangle({ x: M, y: w.y - h, width: w.width - fi, height: h, color: SURFACE });
          w.y -= 5;
          w.text(fromSpans(parseInline(f.label)), { size: 10, indent: fi + 8, maxWidth: w.width - fi - 16 });
          w.y -= 9;
          break;
        }
        case 'checkbox':
          w.checkRow(fromSpans(parseInline(f.label)), answer === true, fi);
          break;
        case 'signoff_list': {
          if (f.label.trim()) w.text(fromSpans(parseInline(f.label)).map(c => ({ ...c, bold: true })), { indent: fi, gap: 2 });
          const confirmed = Array.isArray(answer) ? answer : [];
          for (const item of f.items ?? []) w.checkRow(plain(item.text), confirmed.includes(item.id), fi + 4);
          w.text(plain(`(${ROLE_HE[f.filledBy as SignerRole] ?? ''})`), { size: 8.5, color: MUTED, indent: fi, gap: 4 });
          break;
        }
        case 'signature': {
          const sig = input.sample
            ? { name: 'ישראלה ישראלי', paths: SAMPLE_STROKE, signedAt: input.generatedAt.toISOString() }
            : sigByField.get(f.id);
          w.ensure(118);
          w.y -= 4;
          w.text(plain(f.label.trim() || `חתימת ${ROLE_HE[f.filledBy as SignerRole] ?? ''}`, { bold: true }), { indent: fi, gap: 2 });
          w.text(plain(`שם מלא: ${sig?.name || '—'}`), { indent: fi });
          const boxW = 200; const boxH = 64;
          const boxRight = w.right - fi;
          w.page.drawRectangle({ x: boxRight - boxW, y: w.y - boxH - 4, width: boxW, height: boxH, borderColor: LINE, borderWidth: 1 });
          const fit = sig ? fitSignature(sig.paths, boxW - 16, boxH - 12) : null;
          if (fit) {
            w.page.drawSvgPath(fit.d, {
              x: boxRight - boxW + (boxW - fit.width) / 2, y: w.y - 4 - (boxH - fit.height) / 2,
              scale: fit.scale, borderColor: INK, borderWidth: 1.6 / fit.scale,
            });
          } else {
            drawLine(w.page, plain('לא נחתם'), fonts, { right: boxRight - 10, y: w.y - boxH / 2 - 6, size: 10, color: MUTED });
          }
          w.y -= boxH + 10;
          w.text(plain(`תאריך ושעת חתימה: ${sig ? israelDateTime(sig.signedAt) : '—'}`), { size: 9.5, color: MUTED, indent: fi, gap: 6 });
          break;
        }
        default: {
          if (DISPLAY_ONLY.has(f.type)) break;
          w.text(fromSpans(parseInline(f.label)).map(c => ({ ...c, bold: true })), { size: 10, indent: fi });
          const value = formatAnswer(f, answer);
          w.text(plain(value), { size: 10.5, indent: fi + 8, color: value === '—' ? MUTED : INK });
          if (f.type === 'yes_no' && answer === 'yes' && f.detailsLabel) {
            w.text(plain(`${f.detailsLabel}: ${String(answers[detailsKey(f.id)] ?? '—')}`), { size: 10, indent: fi + 8 });
          }
          w.y -= 4;
        }
      }
    }
    if (section.details) w.rule();
  }

  // ── Audit page ──
  w.newPage();
  w.text(plain('דף ביקורת', { bold: true }), { size: 13, color: BRAND, gap: 6 });
  const row = (label: string, value: string) => w.text([...plain(`${label}: `, { bold: true }), ...plain(value)], { size: 9.5 });
  row('מזהה הגשה', input.submissionId);
  row('טופס', `${input.title}${input.code ? ` (${input.code})` : ''}`);
  row('גרסת טופס', String(input.version));
  w.rule();
  const sigs = input.sample
    ? [{ role: 'parent' as SignerRole, name: 'ישראלה ישראלי', signedAt: input.generatedAt.toISOString(), ip: '0.0.0.0', userAgent: 'SAMPLE', deviceId: 'SAMPLE', userId: 'SAMPLE', version: input.version }]
    : input.signatures;
  for (const s of sigs) {
    w.text(plain(`חתימה — ${ROLE_HE[s.role]}: ${s.name}`, { bold: true }), { size: 10, gap: 1 });
    row('חותמת זמן (UTC)', s.signedAt);
    row('שעון ישראל', israelDateTime(s.signedAt));
    row('כתובת IP', s.ip || '—');
    row('דפדפן / מכשיר (User agent)', s.userAgent || '—');
    row('מזהה מכשיר', s.deviceId || '—');
    row('מזהה משתמש', s.userId || '—');
    w.y -= 6;
  }
  for (const a of input.acknowledgments ?? []) {
    w.text(plain(`אישור קריאה — ${ROLE_HE[a.role]}: ${a.name}`, { bold: true }), { size: 10, gap: 1 });
    row('חותמת זמן (UTC)', a.at);
    row('כתובת IP', a.ip || '—');
    row('דפדפן / מכשיר (User agent)', a.userAgent || '—');
    row('מזהה מכשיר', a.deviceId || '—');
    w.y -= 6;
  }
  w.rule();
  row('ה-PDF הופק (UTC)', input.generatedAt.toISOString());
  row('ה-PDF הופק (שעון ישראל)', israelDateTime(input.generatedAt));

  // ── Footers (+ SAMPLE watermark) ──
  const total = w.pages.length;
  w.pages.forEach((page, i) => {
    const footer = plain(`עמוד ${i + 1} מתוך ${total}`);
    drawLine(page, footer, fonts, { right: 0, left: (A4[0] - lineWidth(footer, fonts, 8.5)) / 2, y: 22, size: 8.5, color: MUTED });
    if (input.sample) {
      page.drawText('SAMPLE', { x: 120, y: 300, size: 110, font: fonts.latinBold, color: BRAND, opacity: 0.1, rotate: degrees(40) });
      drawLine(page, plain('דוגמה — לא לחתימה'), fonts, { right: w.right, y: 22, size: 8.5, color: BRAND });
    }
  });

  doc.setTitle(`${input.title}${input.code ? ` ${input.code}` : ''} v${input.version}`);
  doc.setProducer('FORCA forms');
  doc.setCreationDate(input.generatedAt);
  return doc.save({ useObjectStreams: true });
}
