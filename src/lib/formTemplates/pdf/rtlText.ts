import type { PDFFont, PDFPage, RGB } from 'pdf-lib';

// Right-to-left text for pdf-lib, which draws glyphs strictly left to right
// and knows nothing about bidi. Same approach as incore-site's
// src/domain/digital/watermark.ts (visualRuns), extended with per-character
// styling (bold / underline, from richText.ts markup) so a styled span keeps
// its style after reordering:
//
//   1. each character is classified strong-RTL (Hebrew), strong-LTR (Latin
//      letters, digits), or neutral (spaces, punctuation) — a
//      neutral joins its neighbours when both sides agree, else goes RTL
//      (the paragraph direction);
//   2. same-direction characters group into runs; the run ORDER is reversed
//      and each RTL run's characters are reversed (with () [] {} <> mirrored),
//      LTR runs (English words, numbers, emails, "1.2.3") stay as they are;
//   3. the visual line is drawn left to right, Hebrew glyphs (and spaces
//      inside Hebrew) with Noto Sans Hebrew, everything else with Helvetica.
//      fontkit (pdf-lib's custom-font layout) itself lays a Hebrew string out
//      right-to-left, so each Hebrew-font piece is handed to drawText back in
//      logical order — fontkit's reversal then lands it in visual order.
//
// Enough for Hebrew forms with English words and numbers inside; not a full
// Unicode Bidirectional Algorithm (no embedding levels / explicit marks).

export interface StyledChar { c: string; bold?: boolean; underline?: boolean }
export interface Fonts { he: PDFFont; latin: PDFFont; latinBold: PDFFont }

const HEBREW = /[֐-׿יִ-ﭏ]/;
// Only letters and digits are strong LTR — punctuation (. : - / @ …) is neutral and
// follows its neighbours, so "שעה: 12:30", "ה-App" and "parent@example.com" all land right.
const LATIN = /[A-Za-z0-9\u00C0-\u024F]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

export const plain = (text: string, style: Omit<StyledChar, 'c'> = {}): StyledChar[] => [...text].map(c => ({ c, ...style }));

/** Visual (left-to-right drawing) order of one logical RTL line. */
export function visualOrder(line: StyledChar[]): StyledChar[] {
  const strong = line.map(ch => (HEBREW.test(ch.c) ? 'R' : LATIN.test(ch.c) ? 'L' : 'N'));
  const dir = strong.map((d, i) => {
    if (d !== 'N') return d;
    let prev = 'R';
    for (let j = i - 1; j >= 0; j--) if (strong[j] !== 'N') { prev = strong[j]; break; }
    let next = 'R';
    for (let j = i + 1; j < strong.length; j++) if (strong[j] !== 'N') { next = strong[j]; break; }
    return prev === next ? prev : 'R';
  });
  const runs: { rtl: boolean; chars: StyledChar[] }[] = [];
  line.forEach((ch, i) => {
    const rtl = dir[i] === 'R';
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.chars.push(ch);
    else runs.push({ rtl, chars: [ch] });
  });
  return runs.reverse().flatMap(r => (r.rtl ? r.chars.slice().reverse().map(ch => ({ ...ch, c: MIRROR[ch.c] ?? ch.c })) : r.chars));
}

/** Helvetica (WinAnsi) can't draw everything — anything else becomes "?" instead of failing the PDF. */
const latinSafe = (c: string) => (/[\x20-\x7E\u00A0-\u00FF\u2022\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u20AC]/.test(c) ? c : '?');

interface Piece { text: string; font: PDFFont; bold: boolean; underline: boolean; width: number }

function pieces(visual: StyledChar[], fonts: Fonts, size: number): Piece[] {
  const out: Piece[] = [];
  visual.forEach((ch, i) => {
    // A space takes the Hebrew font when it sits between Hebrew letters, so spacing matches.
    const neighbourHebrew = HEBREW.test(visual[i - 1]?.c ?? '') || HEBREW.test(visual[i + 1]?.c ?? '');
    const he = HEBREW.test(ch.c) || (ch.c === ' ' && neighbourHebrew);
    const font = he ? fonts.he : ch.bold ? fonts.latinBold : fonts.latin;
    const c = he ? ch.c : latinSafe(ch.c);
    const last = out[out.length - 1];
    if (last && last.font === font && last.bold === !!ch.bold && last.underline === !!ch.underline) last.text += c;
    else out.push({ text: c, font, bold: !!ch.bold, underline: !!ch.underline, width: 0 });
  });
  for (const p of out) p.width = p.font.widthOfTextAtSize(p.text, size);
  return out;
}

export const lineWidth = (line: StyledChar[], fonts: Fonts, size: number) =>
  pieces(visualOrder(line), fonts, size).reduce((w, p) => w + p.width, 0);

/** Draws one logical line ending at `right` (RTL alignment) — or starting at `left` when given. Returns the drawn width. */
export function drawLine(page: PDFPage, line: StyledChar[], fonts: Fonts, opts: {
  right: number; y: number; size: number; color: RGB; left?: number; opacity?: number;
}): number {
  const ps = pieces(visualOrder(line), fonts, opts.size);
  const total = ps.reduce((w, p) => w + p.width, 0);
  let x = opts.left ?? opts.right - total;
  for (const p of ps) {
    const text = p.font === fonts.he ? [...p.text].reverse().join('') : p.text;
    page.drawText(text, { x, y: opts.y, size: opts.size, font: p.font, color: opts.color, opacity: opts.opacity ?? 1 });
    // Noto Sans Hebrew has no bold face here — overprint slightly offset to embolden.
    if (p.bold && p.font === fonts.he) {
      page.drawText(text, { x: x + opts.size * 0.035, y: opts.y, size: opts.size, font: p.font, color: opts.color, opacity: opts.opacity ?? 1 });
    }
    if (p.underline && p.text.trim()) {
      page.drawLine({ start: { x, y: opts.y - opts.size * 0.15 }, end: { x: x + p.width, y: opts.y - opts.size * 0.15 }, thickness: Math.max(0.5, opts.size / 18), color: opts.color });
    }
    x += p.width;
  }
  return total;
}

/** Word-wraps a logical paragraph (no newlines) to `maxWidth`, measuring with the fonts it'll be drawn with. A single over-long word is split by characters. */
export function wrapLine(text: StyledChar[], fonts: Fonts, size: number, maxWidth: number): StyledChar[][] {
  const words: StyledChar[][] = [];
  let cur: StyledChar[] = [];
  for (const ch of text) {
    if (ch.c === ' ') {
      if (cur.length) words.push(cur);
      cur = [];
    } else cur.push(ch);
  }
  if (cur.length) words.push(cur);
  if (!words.length) return [[]];

  const lines: StyledChar[][] = [];
  let line: StyledChar[] = [];
  const space = (w: StyledChar[]): StyledChar => ({ c: ' ', bold: w[0]?.bold, underline: w[0]?.underline && line[line.length - 1]?.underline });
  for (let word of words) {
    while (lineWidth(word, fonts, size) > maxWidth && word.length > 1) {
      // Split an unbreakable token (a long URL / user agent) at the widest prefix that fits.
      let n = word.length - 1;
      while (n > 1 && lineWidth(word.slice(0, n), fonts, size) > maxWidth) n--;
      if (line.length) { lines.push(line); line = []; }
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    const next = line.length ? [...line, space(word), ...word] : word;
    if (line.length && lineWidth(next, fonts, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line.length) lines.push(line);
  return lines;
}
