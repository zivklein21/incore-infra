// Run: npm test
// FORCA forms system — nested sections + numbering, publish checks, server
// form logic, RTL text ordering for the PDF, and a PDF render smoke test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { hebrewLetter, normalizeSections, publishIssues, sectionNumbers, templateContentHash, TemplateSection } from '../src/lib/formTemplates/schema';
import { answerFormatError, canFill, missingRequired, pruneHidden, visibleIds } from '../src/lib/formTemplates/logic';
import { plain, visualOrder } from '../src/lib/formTemplates/pdf/rtlText';
import { fitSignature, israelDateTime, renderFormPdf } from '../src/lib/formTemplates/pdf/renderFormPdf';
import { parseRichText } from '../src/lib/formTemplates/richText';
import { computeSubmissionStatus } from '../src/lib/formTemplates/submissions';
import { applySignupFlow, normalizeSteps } from '../src/lib/signupFlow/shared';

const vis = (text: string) => visualOrder(plain(text)).map(c => c.c).join('');

test('RTL visual order: punctuation follows its neighbours, English/numbers stay LTR', () => {
  assert.equal(vis('שעה: 12:30'), '12:30 :העש');
  assert.equal(vis('גרסה 2.1 של ה-App'), 'App-ה לש 2.1 הסרג');
  assert.equal(vis('Email של ההורה'), 'הרוהה לש Email');
  assert.equal(vis('אסטמה (Asthma)'), '(Asthma) המטסא');
  assert.equal(vis('parent@example.com'), 'parent@example.com');
  assert.equal(vis('1.2.3. כותרת'), 'תרתוכ .1.2.3');
});

const sec = (id: string, extra: Partial<TemplateSection> = {}): TemplateSection => ({ id, title: id, fields: [], ...extra });

test('sectionNumbers: 1 / 1.1 / 1.1.1, recomputed from order; unnumbered sections are skipped', () => {
  const sections = [sec('a'), sec('b', { parentId: 'a' }), sec('c', { parentId: 'b' }), sec('d', { parentId: 'a' }), sec('e'), sec('sig', { unnumbered: true }), sec('f')];
  const n = sectionNumbers(sections);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(id => n.get(id)), ['1', '1.1', '1.1.1', '1.2', '2', '3']);
  assert.equal(n.get('sig'), undefined);
});

test('hebrewLetter: א ב ג … ת then תא', () => {
  assert.equal(hebrewLetter(0), 'א');
  assert.equal(hebrewLetter(2), 'ג');
  assert.equal(hebrewLetter(21), 'ת');
  assert.equal(hebrewLetter(22), 'תא');
});

test('normalizeSections keeps valid section nesting and drops a parent that would break contiguity', () => {
  const out = normalizeSections([
    sec('a'), sec('b', { parentId: 'a' }), sec('c'), sec('d', { parentId: 'a' }), // d's parent block already closed by c
  ], 'parent');
  assert.equal(out[1].parentId, 'a');
  assert.equal(out[3].parentId, undefined);
});

test('new optional keys are absent from old templates, so their content hash is unchanged', () => {
  const sections = normalizeSections([{ id: 's', title: 'T', fields: [{ id: 'f', type: 'short_text', label: 'L', required: true, filledBy: 'parent' }] }], 'parent');
  assert.deepEqual(Object.keys(sections[0]).sort(), ['fields', 'id', 'title']);
  assert.equal(templateContentHash({ signers: ['parent'], sections }), templateContentHash({ signers: ['parent'], sections: JSON.parse(JSON.stringify(sections)) }));
});

test('normalizeSections: admin/signer fillers, prefill, yes/no details, dropdown options, items', () => {
  const [s] = normalizeSections([{ id: 's', title: '', items: [{ id: 'i', text: ' א ' }, { id: 'j', text: '' }], fields: [
    { id: 'a', type: 'short_text', label: 'Event', required: true, filledBy: 'admin', prefill: 'child.fullName' },
    { id: 'b', type: 'israeli_id', label: 'ID', required: true, filledBy: 'signer', prefill: 'child.idNumber' },
    { id: 'c', type: 'yes_no', label: 'Q', required: true, filledBy: 'parent', detailsLabel: 'Details' },
    { id: 'd', type: 'dropdown', label: 'D', required: false, filledBy: 'parent', options: [{ id: 'x', label: 'X' }] },
    { id: 'e', type: 'signature', label: 'S', required: true, filledBy: 'admin' },
  ] }], 'parent');
  const f = Object.fromEntries(s.fields.map(x => [x.id, x]));
  assert.equal(f.a.filledBy, 'admin');
  assert.equal(f.a.prefill, undefined); // admin fields are filled by the admin, never prefilled
  assert.equal(f.b.filledBy, 'signer');
  assert.equal(f.b.prefill, 'child.idNumber');
  assert.equal(f.c.detailsLabel, 'Details');
  assert.deepEqual(f.d.options, [{ id: 'x', label: 'X' }]);
  assert.equal(f.e.filledBy, 'parent'); // a signature always belongs to a signer
  assert.deepEqual(s.items, [{ id: 'i', text: 'א' }]);
});

test('publishIssues: signature per required signer, no empty sections, choice options', () => {
  const sections: TemplateSection[] = [
    sec('a', { title: '', fields: [] }),
    sec('b', { fields: [{ id: 'r', type: 'single_select', label: 'R', required: true, filledBy: 'parent', options: [{ id: 'o', label: 'O' }] }] }),
    sec('c', { fields: [{ id: 'sig', type: 'signature', label: 'S', required: true, filledBy: 'parent' }] }),
  ];
  const keys = publishIssues({ name: 'F', signers: ['parent', 'trainee'], sections, visibleOn: 'both', multiSigner: true }).map(i => i.key);
  assert.ok(keys.includes('sig-trainee'));
  assert.ok(!keys.includes('sig-parent'));
  assert.ok(keys.includes('empty-a'));
  assert.ok(keys.includes('opts-r'));
  const ok = publishIssues({ name: 'F', signers: ['parent'], sections: sections.slice(2), visibleOn: 'parent', multiSigner: true });
  assert.deepEqual(ok, []);
  const hidden = publishIssues({ name: 'F', signers: ['parent'], sections: sections.slice(2), visibleOn: 'trainee', multiSigner: true });
  assert.deepEqual(hidden.map(i => i.key), ['visible-parent']);
});

test('logic: a hidden parent section hides its sub-sections; signer fields go to whoever fills first', () => {
  const sections: TemplateSection[] = [
    sec('a', { fields: [{ id: 'q', type: 'yes_no', label: 'Q', required: true, filledBy: 'parent' }] }),
    sec('b', { showIf: { fieldId: 'q', op: 'equals', value: 'yes' }, fields: [{ id: 'x', type: 'short_text', label: 'X', required: true, filledBy: 'parent' }] }),
    sec('c', { parentId: 'b', fields: [{ id: 'y', type: 'short_text', label: 'Y', required: true, filledBy: 'signer' }] }),
  ];
  assert.ok(!visibleIds(sections, { q: 'no' }).has('c'));
  assert.ok(visibleIds(sections, { q: 'yes' }).has('y'));
  assert.deepEqual(missingRequired(sections, { q: 'yes' }, 'trainee').map(f => f.id), ['y']);
  assert.equal(canFill(sections[2].fields[0], 'trainee', { y: 'parent' }), false);
  assert.deepEqual(Object.keys(pruneHidden(sections, { q: 'no', x: 'stale' })), ['q']);
});

test('answer formats: Israeli ID check digit, phone, email, time', () => {
  const f = (type: any) => ({ id: 'f', type, label: '', required: true, filledBy: 'parent' as const });
  assert.equal(answerFormatError(f('israeli_id'), '000000018'), '');
  assert.equal(answerFormatError(f('israeli_id'), '123456789'), 'invalid_israeli_id');
  assert.equal(answerFormatError(f('phone'), '050-123-4567'), '');
  assert.equal(answerFormatError(f('phone'), '123'), 'invalid_phone');
  assert.equal(answerFormatError(f('email'), 'a@b.co'), '');
  assert.equal(answerFormatError(f('email'), 'a@b'), 'invalid_email');
  assert.equal(answerFormatError(f('time'), '23:59'), '');
  assert.equal(answerFormatError(f('time'), '24:00'), 'invalid_time');
});

test('submission status: pending parent → pending child → completed (acknowledgers last)', () => {
  const base = { signers: ['parent', 'trainee'] as ('parent' | 'trainee')[], acknowledgers: [] as ('parent' | 'trainee')[], resignFromVersion: 0 };
  assert.equal(computeSubmissionStatus({ ...base, signedRoles: [], ackRoles: [], version: 1 }).status, 'pending_parent');
  assert.equal(computeSubmissionStatus({ ...base, signedRoles: ['parent'], ackRoles: [], version: 1 }).status, 'pending_child');
  assert.equal(computeSubmissionStatus({ ...base, signedRoles: ['trainee'], ackRoles: [], version: 1 }).status, 'pending_parent');
  assert.equal(computeSubmissionStatus({ ...base, signedRoles: ['parent', 'trainee'], ackRoles: [], version: 1 }).status, 'completed');
  assert.equal(computeSubmissionStatus({ signers: ['parent'], acknowledgers: ['trainee'], resignFromVersion: 0, signedRoles: ['parent'], ackRoles: [], version: 1 }).status, 'pending_child');
});

test('rich text: bold/underline spans, bullets and numbered lines', () => {
  const blocks = parseRichText('שלום **עולם** __קו__\n- פריט\n2) שני');
  assert.equal(blocks[0].kind, 'p');
  assert.deepEqual(blocks[0].spans.map(s => [s.text, s.bold, s.underline]), [['שלום ', false, false], ['עולם', true, false], [' ', false, false], ['קו', false, true]]);
  assert.equal(blocks[1].kind, 'bullet');
  assert.deepEqual(blocks[2].kind === 'number' && blocks[2].marker, '2.');
});

test('israelDateTime: DD/MM/YYYY HH:mm in Asia/Jerusalem (DST-aware)', () => {
  assert.equal(israelDateTime('2026-10-30T12:05:00Z'), '30/10/2026 14:05'); // IST, UTC+2
  assert.equal(israelDateTime('2026-07-01T12:05:00Z'), '01/07/2026 15:05'); // IDT, UTC+3
});

test('fitSignature scales strokes into the box', () => {
  const fit = fitSignature(['M100,100 L300,100', 'M100,150 L300,200'], 200, 50);
  assert.ok(fit && fit.width <= 200 && fit.height <= 50);
  assert.equal(fitSignature([], 10, 10), null);
});

test('renderFormPdf: real + SAMPLE render, page count includes the audit page', async () => {
  const sections: TemplateSection[] = [
    sec('a', { title: 'פרטים', description: '**חשוב:** קראו בעיון', items: [{ id: 'i', text: 'פריט ראשון' }], fields: [
      { id: 'n', type: 'short_text', label: 'שם', required: true, filledBy: 'parent' },
      { id: 'pb', type: 'page_break', label: '', required: false, filledBy: 'parent' },
      { id: 'sig', type: 'signature', label: 'חתימה', required: true, filledBy: 'parent' },
    ] }),
  ];
  const bytes = await renderFormPdf({
    title: 'טופס', code: 'FORCA-01', version: 2, sections, answers: { n: 'נועה' },
    signatures: [{ fieldId: 'sig', role: 'parent', userId: 'u', name: 'דנה', paths: ['M1,1 L20,20'], signedAt: '2026-10-30T12:00:00Z', ip: '1.1.1.1', userAgent: 'UA', deviceId: 'd', version: 2 }],
    submissionId: 's1', childName: 'נועה', generatedAt: new Date(),
  });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 3); // page 1, page break → page 2, audit page
  const sample = await renderFormPdf({ title: 'טופס', code: '', version: 1, sections, answers: {}, signatures: [], submissionId: 'SAMPLE', childName: '', generatedAt: new Date(), sample: true });
  assert.ok((await PDFDocument.load(sample)).getPageCount() >= 2);
});

test('details box: moved first, never nested, never numbered, can\'t hold sub-sections', () => {
  const out = normalizeSections([
    sec('a'), { ...sec('d'), details: true, parentId: 'a', unnumbered: true } as TemplateSection, sec('b', { parentId: 'd' }), { ...sec('d2'), details: true } as TemplateSection,
  ], 'parent');
  assert.deepEqual(out.map(s => s.id), ['d', 'a', 'b', 'd2']);
  assert.equal(out[0].details, true);
  assert.equal(out[0].parentId, undefined);
  assert.equal(out[0].unnumbered, undefined);
  assert.equal(out[2].parentId, undefined);
  assert.equal(out[3].details, undefined);
  const n = sectionNumbers(out);
  assert.equal(n.get('d'), undefined);
  assert.deepEqual(['a', 'b', 'd2'].map(id => n.get(id)), ['1', '2', '3']);
});

test('a removed built-in form is kept as a step, never gates, and is not re-appended', () => {
  const steps = normalizeSteps('forca', [{ formId: 'orthopedic', included: true, removed: true }]);
  const ortho = steps.find(s => s.formId === 'orthopedic')!;
  assert.deepEqual(ortho, { formId: 'orthopedic', included: false, removed: true });
  assert.equal(steps.filter(s => s.formId === 'orthopedic').length, 1);
  const { flags, signupOrder } = applySignupFlow({ requiresOrthopedicForm: true } as never, steps);
  assert.equal(flags.requiresOrthopedicForm, false);
  assert.ok(!signupOrder.includes('orthopedic'));
});

test('rich text: multi-level numbered lines 1.1 / 1.1.1', () => {
  const b = parseRichText('1. ראשון\n1.1 משני\n1.1.1. שלישי\n2026 שנה');
  assert.deepEqual(b.map(x => x.kind === 'number' ? [x.marker, x.depth] : x.kind), [['1.', 1], ['1.1.', 2], ['1.1.1.', 3], 'p']);
});
