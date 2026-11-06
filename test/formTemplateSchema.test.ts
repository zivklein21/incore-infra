// Run: npm test
// Form template schema v2 — lib/formTemplates/schema.ts: legacy (v1)
// conversion, save-time validation, and the content hash that decides
// whether a save publishes a new version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAcknowledgers,
  resolveTraineeDevice,
  convertLegacySections, normalizeSections, normalizeSigners, templateContentHash, TemplateValidationError,
} from '../src/lib/formTemplates/schema';
import { completionStatus } from '../src/lib/formTemplates/completion';
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
  assert.equal(section.fields[1].parentId, 'q1');
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

test('nesting: valid children keep parentId; out-of-block, cross-section and too-deep parents are dropped', () => {
  const f = (id: string, parentId?: string, type = 'yes_no') => ({ id, type, label: id, required: false, filledBy: 'parent', parentId });
  const [a, b] = normalizeSections([
    { id: 's1', fields: [
      f('top'), f('child', 'top'), f('grand', 'child'), f('great', 'grand'),
      f('sibling', 'top'), f('other'), f('stray', 'top'),
    ] },
    { id: 's2', fields: [f('cross', 'top')] },
  ], 'parent');
  const parent = Object.fromEntries(a.fields.map(x => [x.id, x.parentId]));
  assert.equal(parent.child, 'top');
  assert.equal(parent.grand, 'child');
  assert.equal(parent.great, undefined, 'depth 3 is too deep');
  assert.equal(parent.sibling, undefined, "'great' was made top-level, so 'sibling' is no longer inside top's block");
  assert.equal(parent.stray, undefined, "'other' sits between 'top' and 'stray'");
  assert.equal(b.fields[0].parentId, undefined);
});

test('nesting changes the content hash', () => {
  const base = [{ id: 's', fields: [
    { id: 'q', type: 'yes_no', label: 'Q', required: true, filledBy: 'parent' },
    { id: 'd', type: 'long_text', label: 'D', required: true, filledBy: 'parent', showIf: { fieldId: 'q', op: 'equals', value: 'yes' } },
  ] }];
  const nested = JSON.parse(JSON.stringify(base));
  nested[0].fields[1].parentId = 'q';
  assert.notEqual(
    templateContentHash({ signers: ['parent'], sections: normalizeSections(base, 'parent') }),
    templateContentHash({ signers: ['parent'], sections: normalizeSections(nested, 'parent') }),
  );
});

test('trainee device: default keeps the old hash, a non-default changes it; no account falls back to the parent phone', () => {
  const sections = normalizeSections(legacy, 'parent');
  const base = templateContentHash({ signers: ['parent', 'trainee'], sections });
  assert.equal(templateContentHash({ signers: ['parent', 'trainee'], sections, traineeDevice: 'either' }), base);
  assert.notEqual(templateContentHash({ signers: ['parent', 'trainee'], sections, traineeDevice: 'own_phone' }), base);
  assert.equal(resolveTraineeDevice('own_phone', false), 'parent_phone');
  assert.equal(resolveTraineeDevice('own_phone', true), 'own_phone');
  assert.equal(resolveTraineeDevice('either', false), 'parent_phone');
});

test('acknowledgers: a role is either a signer or an acknowledger; empty list keeps the old hash', () => {
  assert.deepEqual(normalizeAcknowledgers(['trainee', 'parent', 'bogus'], ['parent']), ['trainee']);
  const sections = normalizeSections(legacy, 'parent');
  const base = templateContentHash({ signers: ['parent'], sections });
  assert.equal(templateContentHash({ signers: ['parent'], sections, acknowledgers: [] }), base);
  assert.notEqual(templateContentHash({ signers: ['parent'], sections, acknowledgers: ['trainee'] }), base);
});

test('completion: all signatures and acknowledgments, re-sign versions honoured', () => {
  const sig = (role: 'parent' | 'trainee', version: number) => ({ role, kind: 'signature' as const, version, at: '2026-10-23' });
  const ack = (role: 'parent' | 'trainee', version: number) => ({ role, kind: 'acknowledgment' as const, version, at: '2026-10-23' });
  const base = { signers: ['parent'] as const, acknowledgers: ['trainee'] as const };
  const run = (resignFromVersion: number, records: ReturnType<typeof sig>[]) =>
    completionStatus({ signers: [...base.signers], acknowledgers: [...base.acknowledgers], resignFromVersion, records });

  assert.deepEqual(run(0, [sig('parent', 1)]), { complete: false, missingSignatures: [], missingAcknowledgments: ['trainee'] });
  assert.equal(run(0, [sig('parent', 1), ack('trainee', 1)]).complete, true);
  // A later edit WITHOUT re-sign keeps both valid…
  assert.equal(run(0, [sig('parent', 1), ack('trainee', 1)]).complete, true);
  // …but a version published with "Require re-sign" needs a new signature AND a new acknowledgment.
  assert.deepEqual(run(3, [sig('parent', 1), ack('trainee', 1)]), { complete: false, missingSignatures: ['parent'], missingAcknowledgments: ['trainee'] });
  assert.equal(run(3, [sig('parent', 3), ack('trainee', 4)]).complete, true);
  // An acknowledgment never stands in for a signature.
  assert.deepEqual(run(0, [ack('parent', 1), ack('trainee', 1)]).missingSignatures, ['parent']);
});

test("coach isn't a template role: dropped from signers/acknowledgers, coach-filled fields fall back", () => {
  assert.deepEqual(normalizeSigners(['coach'], 'parent'), ['parent']);
  assert.deepEqual(normalizeSigners(['parent', 'coach'], 'parent'), ['parent']);
  assert.deepEqual(normalizeAcknowledgers(['coach', 'trainee'], ['parent']), ['trainee']);
  const [section] = normalizeSections([{ id: 's', fields: [{ id: 'a', type: 'short_text', label: 'A', filledBy: 'coach' }] }], 'parent');
  assert.equal(section.fields[0].filledBy, 'parent');
});
