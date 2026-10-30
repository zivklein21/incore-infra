import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { MemberProfileItem } from '../entities';
import { formsForCaller } from './getMyForms';
import type { Brand } from './submissions';

// The FIRST-LOGIN gate for sign-up forms (settings.kind 'signup'), reported
// by getProfile (profileResponse.ts) so the app's resolvePostLoginRoute can
// open them before the home screen:
//
//   mine         sign-up forms whose turn is on THIS person's device — a
//                member/trainee signing her own part, or a FORCA parent
//                signing her part for each linked child
//   waitingOnParent  a FORCA trainee whose sign-up form still needs her
//                parent (she's routed to "waiting for your parent", like
//                the built-in parent forms)
//
// Only ever non-empty for accounts created after the form was published as a
// sign-up form (its assignment targets 'new_members'), so nobody who already
// used the app is stopped by it. Never throws — a failure here must not
// block anyone from logging in.

export interface PendingSignupForm { templateId: string; assignmentId: string; title: string; childId?: string; childName?: string }

export async function signupGateFor(memberId: string, table: string, profile: MemberProfileItem): Promise<{ mine: PendingSignupForm[]; waitingOnParent: boolean }> {
  const none = { mine: [], waitingOnParent: false };
  try {
    const brand: Brand = table === FORCA_TABLE_NAME ? 'forca' : 'incore';
    const role = profile.identity?.role ?? profile.role;
    if (role === 'admin' || role === 'coach') return none;

    if (profile.identity?.accountType === 'parent_only') {
      // A parent: her part of each linked child's sign-up forms.
      const links = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILY#' },
      }));
      const mine: PendingSignupForm[] = [];
      for (const link of links.Items ?? []) {
        const childId = String(link.childUid ?? String(link.SK).replace(/^FAMILY#/, ''));
        const forms = await formsForCaller({ uid: memberId, childId, device: 'parent_phone', brand });
        for (const f of forms ?? []) {
          if (f.kind === 'signup' && f.myRoles.length) {
            mine.push({ templateId: f.templateId, assignmentId: f.assignmentId, title: f.title, childId, childName: String(link.childName ?? '') });
          }
        }
      }
      return { mine, waitingOnParent: false };
    }

    const forms = await formsForCaller({ uid: memberId, childId: memberId, device: 'trainee_phone', brand });
    const signup = (forms ?? []).filter(f => f.kind === 'signup' && f.status !== 'completed');
    return {
      mine: signup.filter(f => f.myRoles.length).map(f => ({ templateId: f.templateId, assignmentId: f.assignmentId, title: f.title })),
      waitingOnParent: brand === 'forca' && signup.some(f => !f.myRoles.length && f.waiting.includes('parent')),
    };
  } catch (err) {
    console.error('[signupGate] failed — not gating', memberId, err);
    return none;
  }
}

