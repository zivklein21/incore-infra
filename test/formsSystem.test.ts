// Run: npm test
// FORCA forms system — nested sections + numbering, publish checks, server
// form logic, RTL text ordering for the PDF, and a PDF render smoke test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { hebrewLetter, normalizeSections, publishIssues, sectionNumbers, templateContentHash, TemplateSection } from '../src/lib/formTemplates/schema';
import { answerFormatError, canFill, evaluateOutcome, missingRequired, pruneHidden, visibleIds } from '../src/lib/formTemplates/logic';
import { plain, visualOrder } from '../src/lib/formTemplates/pdf/rtlText';
import { fitSignature, israelDateTime, renderFormPdf } from '../src/lib/formTemplates/pdf/renderFormPdf';
import { parseRichText } from '../src/lib/formTemplates/richText';
import { assignmentKey, computeSubmissionStatus, latestByAssignment, targetIncludes, type FormSubmissionItem } from '../src/lib/formTemplates/submissions';
import { rolesOnDevice } from '../src/lib/formTemplates/familyForms';
import { applySignupFlow, normalizeSteps } from '../src/lib/signupFlow/shared';
import { inParentSignupFlow, inTraineeSignupFlow, orphanedSignedForms, parentOwesAtSignup, parentPendingCount, parentSection, withParentSections } from '../src/lib/formTemplates/parentForms';
import { applyConsentChange, consentPdfContent, consentStatus, currentConsent, isPhotoConsentForm, NO_CONSENT, signatureError } from '../src/lib/photoConsent/shared';
import { signupChanges, sortBySignupOrder, withTemplateState } from '../src/lib/formTemplates/signupTemplates';

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
  // No signature box is fine: that signer approves instead.
  assert.ok(!keys.includes('sig-trainee'));
  assert.ok(!keys.includes('sig-parent'));
  assert.ok(keys.includes('empty-a'));
  assert.ok(keys.includes('opts-r'));
  const ok = publishIssues({ name: 'F', signers: ['parent'], sections: sections.slice(2), visibleOn: 'parent', multiSigner: true });
  assert.deepEqual(ok, []);
  // Parent on the parent's phone, trainee on her own: each signs from their own device.
  const ownDevices = publishIssues({ name: 'F', signers: ['parent', 'trainee'], sections: sections.slice(2), visibleOn: 'trainee', multiSigner: true });
  assert.deepEqual(ownDevices, []);
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
    signatures: [{ fieldId: 'sig', role: 'parent', userId: 'u', name: 'דנה', paths: ['M1,1 L20,20'], signedAt: '2026-10-30T12:00:00Z', device: 'parent_phone', version: 2 }],
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

test('new_members target: only accounts created after the assignment; migrated (no createdAt) never', () => {
  const at = '2026-11-01T10:00:00.000Z';
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'a', createdAt: '2026-11-02T00:00:00.000Z' }, at), true);
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'b', createdAt: '2026-10-01T00:00:00.000Z' }, at), false);
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'c' }, at), false);
});

test('INCORE: every role is done on the member\'s own device', () => {
  assert.deepEqual(rolesOnDevice('trainee_phone', ['parent', 'trainee'], 'own_phone', 'incore'), ['parent', 'trainee']);
  assert.deepEqual(rolesOnDevice('trainee_phone', ['parent', 'trainee'], 'own_phone', 'forca'), ['trainee']);
});

test('outcome: approved only when every condition matches (photo consent: parent AND child yes)', () => {
  const sections: TemplateSection[] = [sec('a', { fields: [
    { id: 'p', type: 'yes_no', label: 'P', required: true, filledBy: 'parent' },
    { id: 'c', type: 'yes_no', label: 'C', required: true, filledBy: 'trainee' },
  ] })];
  const outcome = { label: 'צילום', conditions: [{ fieldId: 'p', value: 'yes' }, { fieldId: 'c', value: 'yes' }], approvedText: 'מאושר', notApprovedText: 'לא מאושר', alert: false };
  assert.equal(evaluateOutcome(outcome, sections, { p: 'yes', c: 'yes' })?.approved, true);
  assert.equal(evaluateOutcome(outcome, sections, { p: 'yes', c: 'no' })?.text, 'לא מאושר');
  assert.equal(evaluateOutcome(outcome, sections, { p: 'no', c: 'no' })?.approved, false);
  assert.equal(evaluateOutcome(undefined, sections, {}), null);
});

const tpl = (id: string, over: Partial<{ status: string; publishedVersion: number; kind: 'signup' | 'activity'; audience: string }> = {}) => ({
  id, status: over.status ?? 'published', publishedVersion: over.publishedVersion ?? 1,
  settings: { kind: over.kind ?? 'activity', audience: over.audience },
});

test('sign-up order: a template toggle shows the real state, whatever the saved step says', () => {
  const steps = [{ formId: 'template:a', included: false }, { formId: 'template:b', included: true }, { formId: 'template:gone', included: true }];
  assert.deepEqual(withTemplateState(steps, [tpl('a', { kind: 'signup' }), tpl('b'), tpl('c', { kind: 'signup' })]), [
    { formId: 'template:a', included: true },
    { formId: 'template:b', included: false },
    { formId: 'template:c', included: true },
  ]);
});

test('sign-up order: drafts, archived and coach forms can never be included', () => {
  const steps = [{ formId: 'template:d', included: true }, { formId: 'template:x', included: true }, { formId: 'template:k', included: true }];
  const templates = [tpl('d', { status: 'draft', publishedVersion: 0, kind: 'signup' }), tpl('x', { status: 'archived', kind: 'signup' }), tpl('k', { audience: 'coaches' })];
  assert.ok(withTemplateState(steps, templates).every(s => !s.included));
  assert.deepEqual(signupChanges(steps, templates), []);
});

test('sign-up order: toggles only change what differs, and leave unlisted templates alone', () => {
  const a = tpl('a'); const b = tpl('b', { kind: 'signup' }); const c = tpl('c', { kind: 'signup' }); const d = tpl('d', { kind: 'signup' });
  const changes = signupChanges([
    { formId: 'template:a', included: true }, { formId: 'template:b', included: true }, { formId: 'template:c', included: false },
  ], [a, b, c, d]);
  assert.deepEqual(changes.map(x => [x.template.id, x.signup, x.kindChanged]), [['a', true, true], ['b', true, false], ['c', false, true]]);
});

test('sign-up order: pending forms follow the admin order, unlisted last', () => {
  const steps = [{ formId: 'template:b', included: true }, { formId: 'registration', included: false }, { formId: 'template:a', included: true }];
  const ids = sortBySignupOrder([{ templateId: 'z' }, { templateId: 'a' }, { templateId: 'b' }, { templateId: 'y' }], steps).map(f => f.templateId);
  assert.deepEqual(ids, ['b', 'a', 'z', 'y']);
});

test('a form switched on after an account exists never reaches that account', () => {
  const on = '2026-11-04T10:00:00.000Z';
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'old', createdAt: '2026-11-01T00:00:00.000Z' }, on), false);
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'legacy' }, on), false);
  assert.equal(targetIncludes({ kind: 'new_members' }, { uid: 'new', createdAt: '2026-11-04T11:00:00.000Z' }, on), true);
});

const row = (over: Record<string, unknown> = {}) => ({ status: 'pending_parent', myRoles: [] as string[], waiting: [] as string[], signers: ['parent', 'trainee'], acknowledgers: [], ...over });

test('parent forms: to sign only while the parent is missing', () => {
  assert.equal(parentSection(row({ myRoles: ['parent', 'trainee'] })), 'to_sign');
  // Parent signed, the trainee still has to — on her own phone, or on the parent's.
  assert.equal(parentSection(row({ status: 'pending_child', waiting: ['trainee'] })), 'waiting_trainee');
  assert.equal(parentSection(row({ status: 'pending_child', myRoles: ['trainee'] })), 'waiting_trainee');
});

test('parent forms: a trainee-only form never asks the parent', () => {
  assert.equal(parentSection(row({ status: 'pending_child', signers: ['trainee'], myRoles: ['trainee'] })), 'waiting_trainee');
  const counted = withParentSections([row({ status: 'pending_child', signers: ['trainee'], myRoles: ['trainee'] }), row({ myRoles: ['parent'] }), row({ status: 'completed' })]);
  assert.equal(parentPendingCount(counted), 1);
});

test('parent forms: completed forms follow who signed and the admin setting', () => {
  assert.equal(parentSection(row({ status: 'completed', showIn: 'trainee' })), 'signed');
  assert.equal(parentSection(row({ status: 'completed', signers: ['trainee'], showIn: 'both' })), 'signed');
  assert.equal(parentSection(row({ status: 'completed', signers: ['trainee'], showIn: 'trainee' })), 'hidden');
});

const signedSub = (id: string, over: Record<string, unknown> = {}) => ({
  submissionId: id, templateId: 't', assignmentId: 'signup', childId: 'c', status: 'completed', createdAt: '2026-11-01', completedAt: '2026-11-01', ...over,
}) as never;

test('signed forms: nothing signed is lost when its assignment changes', () => {
  // Shown already → not repeated. Re-sign required → previous version. Assignment ended → still signed.
  assert.deepEqual(orphanedSignedForms([signedSub('a')], 'c', [{ templateId: 't', assignmentId: 'signup', submissionId: 'a' }]), []);
  const resigned = orphanedSignedForms([signedSub('a')], 'c', [{ templateId: 't', assignmentId: 'signup', submissionId: null }]);
  assert.equal(resigned[0].previousVersion, true);
  const ended = orphanedSignedForms([signedSub('a')], 'c', []);
  assert.equal(ended[0].previousVersion, false);
  assert.deepEqual(orphanedSignedForms([signedSub('a', { status: 'pending_child' }), signedSub('b', { childId: 'other' })], 'c', []), []);
});

test('photo consent: approved only when both agree', () => {
  assert.equal(consentStatus(NO_CONSENT), 'not_approved');
  assert.equal(consentStatus({ parent: 'agree', trainee: null }), 'pending');
  assert.equal(consentStatus({ parent: 'refuse', trainee: 'agree' }), 'pending');
  assert.equal(consentStatus({ parent: 'agree', trainee: 'agree' }), 'approved');
});

test('photo consent: either side refusing revokes at once and needs both again', () => {
  const approved = { parent: 'agree', trainee: 'agree' } as const;
  const revoked = applyConsentChange(approved, 'trainee', 'refuse');
  assert.equal(consentStatus(revoked), 'not_approved');
  // The parent's earlier agreement doesn't survive: agreeing again asks the other side.
  const again = applyConsentChange(revoked, 'trainee', 'agree');
  assert.equal(consentStatus(again), 'pending');
  assert.equal(consentStatus(applyConsentChange(again, 'parent', 'agree')), 'approved');
});

test('photo consent: the latest of the form and a change wins', () => {
  const form = { approved: true, at: '2026-11-02' };
  assert.deepEqual(currentConsent(null, form), { parent: 'agree', trainee: 'agree' });
  assert.deepEqual(currentConsent(null, { approved: false, at: '2026-11-02' }), NO_CONSENT);
  assert.deepEqual(currentConsent({ parent: 'refuse', trainee: null, updatedAt: '2026-11-03' }, form), { parent: 'refuse', trainee: null });
  assert.deepEqual(currentConsent({ parent: 'refuse', trainee: null, updatedAt: '2026-11-01' }, form), { parent: 'agree', trainee: 'agree' });
  assert.equal(isPhotoConsentForm('הודעת פרטיות והסכמה לצילום'), true);
  assert.equal(isPhotoConsentForm('תקנון ותנאי הרשמה'), false);
});

test('photo consent: a change must really be signed', () => {
  assert.equal(signatureError('', ['M1,1']), 'missing_name');
  assert.equal(signatureError('דנה', []), 'missing_signature');
  assert.equal(signatureError('דנה', ['M1,1 L2,2']), null);
});

test('photo consent: each change renders a signed PDF', async () => {
  const { sections, answers } = consentPdfContent({ role: 'parent', decision: 'refuse', status: 'not_approved', childName: 'נועה' });
  const bytes = await renderFormPdf({
    title: 'הסכמה לצילום ולפרסום', code: 'PHOTO-CONSENT', version: 1, sections, answers,
    signatures: [{ fieldId: 'signature', role: 'parent', userId: 'u', name: 'דנה', paths: ['M1,1 L20,20'], signedAt: '2026-11-04T12:00:00Z', device: 'parent_phone', version: 1 }],
    submissionId: 'x', childName: 'נועה', generatedAt: new Date(),
  });
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test('first login: the parent is held only by their own part, or a trainee part that must happen on their phone', () => {
  assert.equal(parentOwesAtSignup({ myRoles: ['parent', 'trainee'], traineeDevice: 'either' }), true);
  assert.equal(parentOwesAtSignup({ myRoles: ['parent'], traineeDevice: 'own_phone' }), true);
  // Parent already signed: the trainee can do hers on her own phone.
  assert.equal(parentOwesAtSignup({ myRoles: ['trainee'], traineeDevice: 'either' }), false);
  assert.equal(parentOwesAtSignup({ myRoles: ['trainee'], traineeDevice: 'parent_phone' }), true);
  assert.equal(parentOwesAtSignup({ myRoles: [], traineeDevice: 'parent_phone' }), false);
});

test('two sign-up forms share an assignment id, but never each other\'s signature', () => {
  const sub = (templateId: string, createdAt: string) => ({ templateId, assignmentId: 'signup', childId: 'c', createdAt }) as FormSubmissionItem;
  const latest = latestByAssignment([sub('terms', '2026-11-05T09:00:00Z'), sub('terms', '2026-11-05T09:09:00Z'), sub('health', '2026-11-05T08:00:00Z')], 'c');
  assert.equal(latest.get(assignmentKey('terms', 'signup'))?.createdAt, '2026-11-05T09:09:00Z');
  assert.equal(latest.get(assignmentKey('health', 'signup'))?.createdAt, '2026-11-05T08:00:00Z');
  assert.equal(latest.get(assignmentKey('photo', 'signup')), undefined);
});

test('sign-up steps: a user\'s own forms stay steps once done; other people\'s and ended forms never are', () => {
  const row = (r: object) => ({ myRoles: [], deviceRoles: ['parent'], signedRoles: [], ackRoles: [], traineeDevice: 'own_phone', ...r });
  assert.equal(inParentSignupFlow(row({ myRoles: ['parent'] })), true);
  assert.equal(inParentSignupFlow(row({ signedRoles: ['parent'] })), true);
  // Trainee-only form on her own phone: not a step for the parent.
  assert.equal(inParentSignupFlow(row({ deviceRoles: [], signedRoles: ['trainee'] })), false);
  assert.equal(inParentSignupFlow(row({ traineeDevice: 'parent_phone', deviceRoles: ['trainee'], signedRoles: ['trainee'] })), true);
  // An ended form the parent signed has no part on the device any more.
  assert.equal(inParentSignupFlow(row({ deviceRoles: [], signedRoles: ['parent'] })), false);
  assert.equal(inTraineeSignupFlow(row({ deviceRoles: ['trainee'], myRoles: ['trainee'] })), true);
  assert.equal(inTraineeSignupFlow(row({ deviceRoles: ['trainee'], signedRoles: ['trainee'] })), true);
  assert.equal(inTraineeSignupFlow(row({ deviceRoles: ['trainee'], signedRoles: ['parent'] })), false);
});
