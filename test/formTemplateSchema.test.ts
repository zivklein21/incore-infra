// Run: npm test
// Form template schema v2 — lib/formTemplates/schema.ts: legacy (v1)
// conversion, save-time validation, and the content hash that decides
// whether a save publishes a new version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertLegacySections, normalizeSections, normalizeSigners, templateContentHash, TemplateValidationError,
} from '../src/lib/formTemplates/schema';
import { formTemplateVersionKey, fromStored, FORM_TEMPLATE_SK_PREFIX } from '../src/lib/formTemplates/shared';

const legacy = [{
  id: 's1', title: 'Health', order: 0, questions: [
    { id: 'q2', text: 'Notes', type: 'text', required: false, options: [], order: 1 },
    { id: 'q1', text: 'Medical condition?', subText: 'Any', type: 'radio', required: true, options: ['Yes', 'No'], order: 0,
      subQuestion: { text: 'Details', triggerOption: 'Yes' } },
  ],
}];

test('v1 questions convert to v2 fields in order, follow-up becomes a conditional field', () => {
  const [section] = convertLegacySections(legacy, 'parent');
  assert.deepEqual(section.fields.map(f => [f.id, f.type]), [
    ['q1', 'single_select'], ['q1_sub', 'long_text'], ['q2', 'long_text'],
  ]);
  assert.deepEqual(section.fields[0].options, [{ id: 'o0', label: 'Yes' }, { id: 'o1', label: 'No' }]);
  assert.deepEqual(section.fields[1].showIf, { fieldId: 'q1', op: 'equals', value: 'o0' });
  assert.equal(section.fields[0].helpText, 'Any');
  assert.equal(section.fields[0].required, true);
});

test('normalizeSections accepts v1 input by converting it', () => {
  const sections = normalizeSections(legacy, 'trainee');
  assert.equal(sections[0].fields.length, 3);
  assert.ok(sections[0].fields.every(f => f.filledBy === 'trainee'));
});

test('a condition pointing at a later field, or at a text field, is dropped', () => {
  const sections = normalizeSections([{ id: 's', title: '', fields: [
    { id: 'a', type: 'short_text', label: 'A', required: false, filledBy: 'parent', showIf: { fieldId: 'b', op: 'equals', value: 'yes' } },
    { id: 'b', type: 'yes_no', label: 'B', required: true, filledBy: 'parent' },
    { id: 'c', type: 'long_text', label: 'C', required: true, filledBy: 'parent', showIf: { fieldId: 'b', op: 'equals', value: 'yes' } },
    { id: 'd', type: 'long_text', label: 'D', required: true, filledBy: 'parent', showIf: { fieldId: 'a', op: 'equals', value: 'x' } },
  ] }], 'parent');
  const byId = Object.fromEntries(sections[0].fields.map(f => [f.id, f]));
  assert.equal(byId.a.showIf, undefined);
  assert.deepEqual(byId.c.showIf, { fieldId: 'b', op: 'equals', value: 'yes' });
  assert.equal(byId.d.showIf, undefined);
});

test('display-only fields are never required; empty options/items are dropped', () => {
  const [section] = normalizeSections([{ id: 's', title: '', fields: [
    { id: 'h', type: 'section_header', label: 'H', required: true, filledBy: 'parent' },
    { id: 'm', type: 'multi_select', label: 'M', required: true, filledBy: 'parent', options: [{ id: 'x', label: 'X' }, { id: 'y', label: '  ' }] },
    { id: 'l', type: 'signoff_list', label: 'L', required: true, filledBy: 'trainee', items: [{ id: 'i1', text: 'I agree', required: false }, { id: 'i2', text: '' }] },
  ] }], 'parent');
  assert.equal(section.fields[0].required, false);
  assert.deepEqual(section.fields[1].options, [{ id: 'x', label: 'X' }]);
  assert.deepEqual(section.fields[2].items, [{ id: 'i1', text: 'I agree', required: false }]);
});

test('duplicate ids and unknown types are rejected', () => {
  assert.throws(() => normalizeSections([{ id: 's', fields: [{ id: 's', type: 'yes_no' }] }], 'parent'), TemplateValidationError);
  assert.throws(() => normalizeSections([{ id: 's', fields: [{ id: 'a', type: 'video' }] }], 'parent'), TemplateValidationError);
});

test('content hash ignores key order and signer order, changes with content', () => {
  const sections = normalizeSections(legacy, 'parent');
  const a = templateContentHash({ signers: normalizeSigners(['trainee', 'parent'], 'parent'), sections });
  const b = templateContentHash({ signers: normalizeSigners(['parent', 'trainee'], 'parent'), sections: JSON.parse(JSON.stringify(sections)) });
  assert.equal(a, b);
  const edited = JSON.parse(JSON.stringify(sections));
  edited[0].fields[0].label = 'Any medical condition?';
  assert.notEqual(a, templateContentHash({ signers: ['parent', 'trainee'], sections: edited }));
});

test('a legacy head reads as version 1; version keys never match the head prefix', () => {
  const stored = fromStored({ id: 't', name: 'T', sections: legacy, createdAt: '2026-10-01', updatedAt: '2026-10-02' }, 'forca');
  assert.equal(stored.legacy, true);
  assert.equal(stored.currentVersion, 1);
  assert.deepEqual(stored.signers, ['parent']);
  assert.ok(!formTemplateVersionKey('t', 3).SK.startsWith(FORM_TEMPLATE_SK_PREFIX));
  assert.equal(formTemplateVersionKey('t', 3).SK, 'FORM_TEMPLATE_VERSION#t#0003');
});
