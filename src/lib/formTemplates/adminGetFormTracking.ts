import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { deriveMemberName } from '../entities';
import { parseBrand } from './shared';
import {
  computeSubmissionStatus, getProfile, getTemplateHead, getTemplateVersion, latestByAssignment, listAssignments, listTrainees,
  listSubmissionsOfTemplate, parentOf, targetIncludes, versionToSign,
} from './submissions';

// GET /adminGetFormTracking?templateId=<id>&brand=incore|forca
// Auth: Cognito JWT, admin only. Per assignment, one row per
// targeted trainee: Pending Parent / Pending Child / Completed (computed
// exactly like the family sees it — getMyForms.ts), who's missing, the
// version they're on, when it completed and whether a signed PDF exists
// (download via getSignedFormPdfUrl.ts, which also generates a missing one).
// Includes trainees who joined after an "all"/group assignment was made.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const templateId = event.queryStringParameters?.templateId ?? '';
  if (!templateId) return json(400, { error: 'missing_template' });

  const brand = parseBrand(event.queryStringParameters?.brand);
  const head = await getTemplateHead(brand, templateId);
  if (!head) return json(404, { error: 'not_found' });
  const [assignments, trainees, subs] = await Promise.all([listAssignments(brand, templateId), listTrainees(brand), listSubmissionsOfTemplate(brand, templateId)]);

  const parentNames = new Map<string, string>();
  const parentName = async (childId: string) => {
    if (!parentNames.has(childId)) {
      const pUid = await parentOf(brand, childId);
      const p = pUid ? await getProfile(brand, pUid) : null;
      parentNames.set(childId, p ? deriveMemberName(p) : '');
    }
    return parentNames.get(childId) ?? '';
  };

  const out = [];
  for (const a of assignments.sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const rows = [];
    for (const tr of trainees.filter(x => targetIncludes(a.target, x, a.createdAt))) {
      const existing = latestByAssignment(subs, tr.uid).get(a.assignmentId);
      const { version, reuse } = head.publishedVersion ? versionToSign(head, existing) : { version: existing?.version ?? 0, reuse: !!existing };
      const t = version ? await getTemplateVersion(brand, templateId, version) : null;
      const sub = reuse ? existing : undefined;
      const { status, missing } = t
        ? computeSubmissionStatus({ signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion, signedRoles: sub?.signedRoles ?? [], ackRoles: sub?.ackRoles ?? [], version })
        : { status: 'pending_parent' as const, missing: [] };
      rows.push({
        childId: tr.uid,
        childName: tr.name,
        parentName: await parentName(tr.uid),
        status,
        missing,
        version,
        submissionId: sub?.submissionId ?? null,
        // An older completed copy (before a "Require re-sign" version) stays downloadable.
        previousSubmissionId: !reuse && existing?.status === 'completed' ? existing.submissionId : null,
        signedRoles: sub?.signedRoles ?? [],
        completedAt: sub?.completedAt ?? null,
        hasPdf: !!sub?.pdfS3Key,
        updatedAt: sub?.updatedAt ?? null,
      });
    }
    rows.sort((x, y) => (x.status === y.status ? x.childName.localeCompare(y.childName, 'he') : x.status === 'completed' ? 1 : y.status === 'completed' ? -1 : 0));
    out.push({
      assignmentId: a.assignmentId,
      target: a.target,
      adminAnswers: a.adminAnswers,
      createdAt: a.createdAt,
      counts: {
        total: rows.length,
        completed: rows.filter(r => r.status === 'completed').length,
        pendingParent: rows.filter(r => r.status === 'pending_parent').length,
        pendingChild: rows.filter(r => r.status === 'pending_child').length,
      },
      rows,
    });
  }

  return json(200, {
    template: { id: head.id, name: head.name, status: head.status, publishedVersion: head.publishedVersion, code: head.settings.code },
    assignments: out,
  });
}
