// The tiny rich-text markup a section's text is stored in — readable as
// plain text, so a section written before rich text existed (or pasted in)
// renders exactly as before. Mirrored in the app's
// src/shared/utils/richText.ts (the builder's B / U / list buttons insert it,
// the form renderer draws it); the PDF renderer uses this copy.
//
//   **bold**   __underline__   (may nest: **__both__**)
//   "- text" or "• text" at a line start → bullet item
//   "1) text" or "1. text" at a line start → numbered list item (number kept);
//   multi-level "1.1 text" / "1.1.1. text" → indented one step per level
//   anything else → a paragraph line

export interface Span { text: string; bold: boolean; underline: boolean }
export type RichBlock =
  | { kind: 'p'; spans: Span[] }
  | { kind: 'bullet'; spans: Span[] }
  /** marker is "1." / "1.2." / "1.2.3."; depth is its level (1 = "1.", 2 = "1.2."…). */
  | { kind: 'number'; marker: string; depth: number; spans: Span[] };

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let bold = false;
  let underline = false;
  let buf = '';
  const flush = () => {
    if (buf) spans.push({ text: buf, bold, underline });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '**') { flush(); bold = !bold; i++; continue; }
    if (two === '__') { flush(); underline = !underline; i++; continue; }
    buf += text[i];
  }
  flush();
  return spans;
}

export function parseRichText(text: string): RichBlock[] {
  return text.split('\n').map((raw): RichBlock => {
    const line = raw.trimEnd();
    const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
    if (bullet) return { kind: 'bullet', spans: parseInline(bullet[1]) };
    // "1." / "1)" — or multi-level "1.1" / "1.1." / "1.1.1)" (a plain "2026 …" isn't a list line).
    const numbered = /^\s*(\d{1,3}(?:\.\d{1,3}){0,5})([.)]?)\s+(.*)$/.exec(line);
    if (numbered && (numbered[2] || numbered[1].includes('.'))) {
      return { kind: 'number', marker: `${numbered[1]}.`, depth: numbered[1].split('.').length, spans: parseInline(numbered[3]) };
    }
    return { kind: 'p', spans: parseInline(line) };
  });
}

/** The text with markup removed (search, previews, short summaries). */
export const stripRichText = (text: string) => text.replace(/\*\*|__/g, '');
