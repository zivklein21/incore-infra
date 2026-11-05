// READ-ONLY. Run: npx --yes --package=tsx@4.19.2 -- tsx scripts/countLegacyFormSignatures.ts
// FORCA trainees whose sign-up forms were signed in the old built-in format
// (stored on the profile, not as a form submission), so the parent's Forms
// page shows nothing for them. Writes nothing: this is the count to review
// before deciding on any migration.
import { listSubmissionsOfChild, listTrainees } from '../src/lib/formTemplates/submissions';

(async () => {
  const trainees = await listTrainees('forca');
  const byForm: Record<string, number> = {};
  let affected = 0;
  for (const { uid, profile } of trainees) {
    const forms = (profile.forms ?? {}) as Record<string, unknown>;
    const legacy = {
      health: !!forms.health_declaration,
      orthopedic: forms.orthopedic_form === true,
      parental_authorization: !!forms.parental_authorization,
      policies: forms.agreedToPolicies === true,
      registration: forms.registration_form === true,
    };
    const signed = Object.entries(legacy).filter(([, done]) => done).map(([id]) => id);
    if (!signed.length) continue;
    const hasTemplateForms = (await listSubmissionsOfChild('forca', uid)).some(s => s.status === 'completed');
    if (hasTemplateForms) continue;
    affected += 1;
    for (const id of signed) byForm[id] = (byForm[id] ?? 0) + 1;
  }
  console.log(JSON.stringify({ trainees: trainees.length, withOnlyLegacyForms: affected, byForm }, null, 2));
})();
