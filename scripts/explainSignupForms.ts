// READ-ONLY. Why does (or doesn't) each sign-up form reach this child's parent?
// Run with the production table names set, passing the child's email, name or uid:
//   npx --yes --package=tsx@4.19.2 -- tsx scripts/explainSignupForms.ts "child@example.com"
// Writes nothing.
import { formsForCaller } from '../src/lib/formTemplates/getMyForms';
import { parentOwesAtSignup } from '../src/lib/formTemplates/parentForms';
import { listAssignments, listTemplateHeads, listTrainees, parentOf, SIGNUP_ASSIGNMENT_ID } from '../src/lib/formTemplates/submissions';

(async () => {
  const query = (process.argv[2] ?? '').toLowerCase();
  if (!query) throw new Error('Pass the child\'s email, name or uid');
  const matches = (await listTrainees('forca')).filter(t => JSON.stringify(t).toLowerCase().includes(query));
  if (matches.length !== 1) {
    console.log(`Found ${matches.length} trainees:`, matches.map(t => t.name));
    return;
  }
  const child = matches[0];
  const parent = await parentOf('forca', child.uid);
  console.log(`Child: ${child.name}, created ${child.createdAt}, parent ${parent ?? 'NOT LINKED'}`);

  const [heads, assignments, rows] = await Promise.all([
    listTemplateHeads('forca'),
    listAssignments('forca'),
    parent ? formsForCaller({ uid: parent, childId: child.uid, device: 'parent_phone', brand: 'forca' }) : [],
  ]);
  const report = heads.map(h => {
    const a = assignments.find(x => x.templateId === h.id && x.assignmentId === SIGNUP_ASSIGNMENT_ID);
    const row = (rows ?? []).find(r => r.templateId === h.id && r.assignmentId === SIGNUP_ASSIGNMENT_ID);
    const why = h.status !== 'published' ? `not published (${h.status})`
      : h.settings.kind !== 'signup' ? 'not a sign-up form'
      : !a ? 'switched on, but has no active sign-up assignment'
      : !child.createdAt || child.createdAt <= a.createdAt ? `child created before the form was switched on (${a.createdAt})`
      : !row ? 'nothing for the parent on their phone'
      : row.status === 'completed' ? 'already completed'
      : parentOwesAtSignup(row as never) ? 'SHOWN TO PARENT'
      : `not the parent's turn (waiting: ${row.waiting.join(', ') || 'none'})`;
    return { form: h.name, signers: h.signers.join('+'), ack: h.acknowledgers.join('+'), traineeDevice: h.traineeDevice, result: why };
  });
  console.table(report);
})();
