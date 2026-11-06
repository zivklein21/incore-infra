// READ-ONLY. Run from incore-infra:
//   FORCA_TABLE_NAME=forca-production-table AWS_REGION=eu-central-1 npx --yes --package=tsx@4.19.2 -- tsx scripts/checkMixedSignupSubmissions.ts
// All sign-up forms share one assignment id, and submissions used to be
// matched by that id alone. Lists two kinds of damage, per trainee:
//   mixed     a stored submission holding signatures or answers of ANOTHER form
//   unsigned  sign-up forms she was shown as signed but has no submission for
// Writes nothing.
import { getTemplateVersion, listAssignments, listSubmissionsOfChild, listTrainees, SIGNUP_ASSIGNMENT_ID, targetIncludes } from '../src/lib/formTemplates/submissions';

(async () => {
  const assignments = (await listAssignments('forca')).filter(a => a.assignmentId === SIGNUP_ASSIGNMENT_ID);
  const trainees = await listTrainees('forca');
  const mixed: unknown[] = [];
  const unsigned: unknown[] = [];
  for (const tr of trainees) {
    const subs = await listSubmissionsOfChild('forca', tr.uid);
    const signup = subs.filter(s => s.assignmentId === SIGNUP_ASSIGNMENT_ID);
    for (const s of signup) {
      const t = await getTemplateVersion('forca', s.templateId, s.version);
      const ids = new Set((t?.sections ?? []).flatMap(x => x.fields.map(f => f.id)));
      const foreign = [...s.signatures.map(x => x.fieldId), ...Object.keys(s.answers).map(k => k.split(':')[0])].filter(id => !ids.has(id));
      if (foreign.length) mixed.push({ trainee: tr.name, form: t?.name ?? s.templateId, submissionId: s.submissionId, foreignFields: foreign.length });
    }
    if (!signup.length) continue;
    const missing = assignments.filter(a => targetIncludes(a.target, tr, a.createdAt) && !signup.some(s => s.templateId === a.templateId));
    if (missing.length) unsigned.push({ trainee: tr.name, formsNeverSigned: missing.length });
  }
  console.log(JSON.stringify({ trainees: trainees.length, mixedCount: mixed.length, mixed, wronglyShownSignedCount: unsigned.length, unsigned }, null, 2));
})();
