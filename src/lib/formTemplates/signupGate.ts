import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { MemberProfileItem } from '../entities';
import { formsForCaller } from './getMyForms';
import { inParentSignupFlow, inTraineeSignupFlow, parentOwesAtSignup } from './parentForms';
import { sortBySignupOrder } from './signupTemplates';
import { loadSignupFlow } from '../signupFlow/shared';
import type { Brand } from './submissions';

// The FIRST-LOGIN gate for sign-up forms (settings.kind 'signup'), reported
// by getProfile (profileResponse.ts) so the app's resolvePostLoginRoute can
// open them before the home screen:
//
//   mine         sign-up forms whose turn is on THIS person's device — a
//                member/trainee signing her own part, or a FORCA parent
//                signing her part for each linked child
//   flow         the same forms plus the ones already done, in order
//   waitingOnParent  a FORCA trainee whose sign-up form still needs her
//                parent (she's routed to "waiting for your parent", like
//                the built-in parent forms)
//
// Only ever non-empty for accounts created after the form was published as a
// sign-up form (its assignment targets 'new_members'), so nobody who already
// used the app is stopped by it. Never throws — a failure here must not
// block anyone from logging in.

export interface PendingSignupForm { templateId: string; assignmentId: string; title: string; childId?: string; childName?: string }
/** One step of this person's sign-up flow, done or still owed — drives the app's progress stepper. */
export type SignupFlowForm = PendingSignupForm & { done: boolean };

const pendingOnly = ({ done: _done, ...form }: SignupFlowForm): PendingSignupForm => form;

type SignupGate = { mine: PendingSignupForm[]; flow: SignupFlowForm[]; waitingOnParent: boolean };

export async function signupGateFor(memberId: string, table: string, profile: MemberProfileItem): Promise<SignupGate> {
  const none: SignupGate = { mine: [], flow: [], waitingOnParent: false };
  try {
    const brand: Brand = table === FORCA_TABLE_NAME ? 'forca' : 'incore';
    const role = profile.identity?.role ?? profile.role;
    if (role === 'admin' || role === 'coach') return none;
    const steps = await loadSignupFlow(brand);

    if (profile.identity?.accountType === 'parent_only') {
      // A parent: her part of each linked child's sign-up forms.
      const links = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILY#' },
      }));
      const all: SignupFlowForm[] = [];
      for (const link of links.Items ?? []) {
        const childId = String(link.childUid ?? String(link.SK).replace(/^FAMILY#/, ''));
        const forms = await formsForCaller({ uid: memberId, childId, device: 'parent_phone', brand });
        for (const f of forms ?? []) {
          if (f.kind === 'signup' && inParentSignupFlow(f)) {
            all.push({ templateId: f.templateId, assignmentId: f.assignmentId, title: f.title, childId, childName: String(link.childName ?? ''), done: !parentOwesAtSignup(f) });
          }
        }
      }
      // Per daughter, each in the admin's First Sign-up Order.
      const byChild = [...new Set(all.map(f => f.childId))];
      const flow = byChild.flatMap(id => sortBySignupOrder(all.filter(f => f.childId === id), steps));
      return { mine: flow.filter(f => !f.done).map(pendingOnly), flow, waitingOnParent: false };
    }

    const forms = await formsForCaller({ uid: memberId, childId: memberId, device: 'trainee_phone', brand });
    const signup = (forms ?? []).filter(f => f.kind === 'signup');
    const flow = sortBySignupOrder(
      signup.filter(inTraineeSignupFlow).map(f => ({ templateId: f.templateId, assignmentId: f.assignmentId, title: f.title, done: !f.myRoles.length })),
      steps,
    );
    return {
      mine: flow.filter(f => !f.done).map(pendingOnly),
      flow,
      waitingOnParent: brand === 'forca' && signup.some(f => f.status !== 'completed' && !f.myRoles.length && f.waiting.includes('parent')),
    };
  } catch (err) {
    console.error('[signupGate] failed — not gating', memberId, err);
    return none;
  }
}
