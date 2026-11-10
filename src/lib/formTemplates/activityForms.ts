import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { deriveMemberName } from '../entities';
import { signedOnOlderDetails, type ChangedDetail } from './activityFields';
import {
  assignmentKey, type Brand, formsTable, getProfile, getTemplateVersion, latestByAssignment, listAssignments, listSubmissionsOfTemplate,
} from './submissions';

export interface SignedOnOlderDetails {
  templateId: string;
  templateName: string;
  assignmentId: string;
  childId: string;
  childName: string;
  /** Who already signed / approved this copy, with the server time. */
  signedBy: { role: string; name: string; at: string }[];
  completed: boolean;
  changed: ChangedDetail[];
}

/**
 * After an activity is edited: every signed (or partly signed) copy of a
 * form attached to it whose signed details now differ from the activity —
 * those families signed an older version. Their copies and PDFs are never
 * touched (activityFields.ts); this only tells the admin who they are.
 * Cheap when nothing is attached: one query over the brand's assignments.
 */
export async function formsSignedOnOlderDetails(brand: Brand, classId: string): Promise<SignedOnOlderDetails[]> {
  const assignments = (await listAssignments(brand)).filter(a => a.target.kind === 'activity' && a.target.classId === classId);
  if (!assignments.length) return [];
  const cls = (await ddb.send(new GetCommand({ TableName: formsTable(brand), Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }))).Item ?? null;
  if (!cls) return [];

  const out: SignedOnOlderDetails[] = [];
  const names = new Map<string, string>();
  const nameOf = async (uid: string) => {
    if (!names.has(uid)) {
      const p = await getProfile(brand, uid);
      names.set(uid, p ? deriveMemberName(p) : '');
    }
    return names.get(uid) ?? '';
  };
  for (const templateId of [...new Set(assignments.map(a => a.templateId))]) {
    const subs = await listSubmissionsOfTemplate(brand, templateId);
    for (const a of assignments.filter(x => x.templateId === templateId)) {
      const childIds = [...new Set(subs.filter(s => s.assignmentId === a.assignmentId).map(s => s.childId))];
      for (const childId of childIds) {
        const sub = latestByAssignment(subs, childId).get(assignmentKey(templateId, a.assignmentId));
        if (!sub) continue;
        const t = await getTemplateVersion(brand, templateId, sub.version);
        if (!t) continue;
        const changed = signedOnOlderDetails({ sections: t.sections, assignmentAdminAnswers: a.adminAnswers, cls, sub });
        if (!changed.length) continue;
        out.push({
          templateId,
          templateName: t.name,
          assignmentId: a.assignmentId,
          childId,
          childName: await nameOf(childId),
          signedBy: [
            ...sub.signatures.map(s => ({ role: s.role, name: s.name, at: s.signedAt })),
            ...sub.acknowledgments.map(x => ({ role: x.role, name: x.name, at: x.at })),
          ].filter((x, i, all) => all.findIndex(y => y.role === x.role) === i),
          completed: sub.status === 'completed',
          changed,
        });
      }
    }
  }
  return out.sort((x, y) => x.childName.localeCompare(y.childName, 'he'));
}
