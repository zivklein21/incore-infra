import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { deriveMemberName } from '../entities';
import { resolveMemberProfile } from '../memberLookup';
import { listTraineeRefunds } from '../forcaRefunds/store';
import { publicRefund } from '../forcaRefunds/handlers';
import {
  CHANNEL_LABEL, MAY_NEED_REFUND, SUGGESTION_LABEL, chargesAfterReceipt, cleanNote, formatIsraelDateTime, parentStatusLabel,
  suggestedEnd, validateManual, validateSettings, validateStatusChange,
} from './rules';
import {
  StateConflictError, changeRequest, childCharges, createRequest, currentAgreementOf, linkedChildren, linkedParents, listParentRequests,
  listRequests, loadForcaProfile, loadLog, loadReceipt, loadSettings, loadState, maySubmitFor, profileName, renderRequestText, saveSettings,
  type RequestReceipt, type RequestState,
} from './store';
import { notifyOrNewRequest, sendParentConfirmation } from './notify';

// FORCA parent cancellation requests. Four routes on the shared integration (incoreWorkoutApi.ts):
//
// Parent (a linked parent, or the payer on the child's subscription):
//   POST getMyForcaCancelRequests  {}                  → { children: [{ uid, name, requestText, subscription }], requests }
//   POST submitForcaCancelRequest  { childUid, note? } → { request }   received now; cancels and stops nothing
// Admin (Or):
//   POST adminForcaCancelRequests  { filter?: open|handled|all } → { requests, unseenCount, settings }
//                                  { requestId }                 → { receipt, state, log, charges, suggestion, refunds }
//                                  { parentsOf: childUid }       → { parents } for the manual entry
//   POST adminForcaCancelRequest   { action: 'setStatus', requestId, status, endDate? }
//                                  { action: 'markSeen', requestId }
//                                  { action: 'addManual', parentUid, childUid, channel, originalAt, content, notifyParent? }
//                                  { action: 'saveSettings', requestText, confirmationText, basedOn }
// New routes: nothing an existing build calls changes.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

function parseBody(event: Event): Record<string, unknown> | null {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function adminActor(uid: string): Promise<{ uid: string; name: string }> {
  try {
    const r = await resolveMemberProfile(uid);
    return { uid, name: (r && deriveMemberName(r.profile)) || uid };
  } catch {
    return { uid, name: uid };
  }
}

/** What a parent sees of a request: no internal fields. */
function forParent(s: RequestState) {
  return {
    requestId: s.requestId,
    requestNumber: s.requestNumber,
    receivedAt: s.receivedAt,
    channel: s.channel,
    childUid: s.childUid,
    childName: s.childName,
    productName: s.productName,
    status: s.status,
    endDate: s.endDate,
    statusLabel: parentStatusLabel(s.status, s.endDate),
  };
}

/** Or's list row. */
function forList(s: RequestState) {
  const { PK: _pk, SK: _sk, GSI1PK: _a, GSI1SK: _b, GSI2PK: _c, GSI2SK: _d, ...rest } = s;
  return { ...rest, parentStatusLabel: parentStatusLabel(s.status, s.endDate) };
}

function publicReceipt(r: RequestReceipt) {
  const { PK: _pk, SK: _sk, ...rest } = r;
  return rest;
}

// ─── Parent ─────────────────────────────────────────────────────────────────

export async function getMyForcaCancelRequests(event: Event): Promise<Result> {
  const uid = getUid(event);
  const [children, requests, settings] = await Promise.all([linkedChildren(uid), listParentRequests(uid), loadSettings()]);
  const withSubs = await Promise.all(children.map(async (c) => {
    const [profile, agreement] = await Promise.all([loadForcaProfile(c.uid), currentAgreementOf(c.uid)]);
    const name = profileName(profile, c.name || 'מתאמנת');
    return {
      uid: c.uid,
      name,
      requestText: renderRequestText(settings.requestText, name),
      subscription: agreement ? { productName: agreement.productName, groupName: agreement.groupName, status: agreement.status } : null,
    };
  }));
  return json(200, { children: withSubs, requests: requests.map(forParent) });
}

export async function submitForcaCancelRequest(event: Event): Promise<Result> {
  const uid = getUid(event);
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });
  // Received now, by the server's clock: nothing the app sends changes the time.
  const receivedAt = new Date().toISOString();
  const childUid = str(body.childUid);
  if (!childUid) return json(400, { error: 'missing_child' });
  const note = cleanNote(body.note);
  if (!note.ok) return json(400, { error: note.error });

  const agreement = await currentAgreementOf(childUid);
  if (!(await maySubmitFor(uid, childUid, agreement))) return json(403, { error: 'not_your_child' });
  const [parent, child, settings] = await Promise.all([loadForcaProfile(uid), loadForcaProfile(childUid), loadSettings()]);
  const childName = profileName(child, 'מתאמנת');

  const { receipt, state } = await createRequest({
    parent, parentUid: uid, child, childUid, agreement, receivedAt, channel: 'app',
    requestText: renderRequestText(settings.requestText, childName), note: note.note,
    by: { uid, name: profileName(parent, 'הורה') },
  });
  console.log(`[submitForcaCancelRequest] ${receipt.requestId} parent=${uid} child=${childUid} received ${receivedAt}`);

  // After the request is saved: it's received whatever happens to the notifications.
  const sent = await sendParentConfirmation(parent, settings.confirmationText, receipt);
  const notified = await changeRequest(receipt.requestId, { system: 'confirmation' }, () => ({
    patch: { parentNotifiedAt: new Date().toISOString() }, action: 'parent_notified', details: sent,
  })).catch((err) => { console.error(`[submitForcaCancelRequest] ${receipt.requestId} logging the confirmation failed:`, err); return null; });
  await notifyOrNewRequest(receipt);

  return json(200, { request: forParent(notified ?? state) });
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export async function adminForcaCancelRequests(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });

  const parentsOf = str(body.parentsOf);
  if (parentsOf) {
    const [uids, agreement] = await Promise.all([linkedParents(parentsOf), currentAgreementOf(parentsOf)]);
    if (agreement?.payerUid && !uids.includes(agreement.payerUid)) uids.push(agreement.payerUid);
    const parents = await Promise.all(uids.map(async (u) => ({ uid: u, name: profileName(await loadForcaProfile(u), u) })));
    return json(200, { parents, subscription: agreement ? { agreementId: agreement.agreementId, productName: agreement.productName, status: agreement.status } : null });
  }

  const requestId = str(body.requestId);
  if (requestId) {
    const [receipt, state, log] = await Promise.all([loadReceipt(requestId), loadState(requestId), loadLog(requestId)]);
    if (!receipt || !state) return json(404, { error: 'request_not_found' });
    const [charges, refunds] = await Promise.all([childCharges(receipt.child.uid), listTraineeRefunds(receipt.child.uid)]);
    const s = suggestedEnd(receipt.receivedAt);
    return json(200, {
      receipt: publicReceipt(receipt),
      receivedAtLabel: formatIsraelDateTime(receipt.receivedAt),
      channelLabel: CHANNEL_LABEL[receipt.source.channel],
      state: forList(state),
      log: log.map(({ PK: _pk, ...rest }) => rest),
      suggestion: { ...s, label: SUGGESTION_LABEL },
      chargesAfterReceipt: chargesAfterReceipt(charges, receipt.receivedAt).map((c) => ({ ...c, ...(c.mayNeedRefund ? { flag: MAY_NEED_REFUND } : {}) })),
      refunds: refunds.filter((r) => (r.details as { parentRequestId?: string } | undefined)?.parentRequestId === requestId).map(publicRefund),
    });
  }

  const filter = body.filter === 'handled' || body.filter === 'all' ? body.filter : 'open';
  const [requests, open, settings] = await Promise.all([
    listRequests(filter),
    filter === 'open' ? Promise.resolve(null) : listRequests('open'),
    loadSettings(),
  ]);
  const unseenCount = (open ?? requests).filter((r) => r.status !== 'done' && !r.seenAt).length;
  return json(200, { requests: requests.map(forList), unseenCount, settings });
}

export async function adminForcaCancelRequest(event: Event): Promise<Result> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });
  const by = await adminActor(uid);

  try {
    if (body.action === 'markSeen') {
      const requestId = str(body.requestId);
      const state = await changeRequest(requestId, by, (s) => ({
        patch: s.seenAt ? null : { seenAt: new Date().toISOString() }, action: 'seen',
      }));
      if (!state) return json(404, { error: 'request_not_found' });
      return json(200, { state: forList(state) });
    }

    if (body.action === 'setStatus') {
      const requestId = str(body.requestId);
      const v = validateStatusChange(body);
      if (!v.ok) return json(400, { error: v.error });
      const state = await changeRequest(requestId, by, (s) => {
        const endDate = v.status === 'end_date_set' ? v.endDate : s.endDate;
        if (s.status === v.status && s.endDate === endDate) return { patch: null, action: 'status' };
        return { patch: { status: v.status, endDate, ...(s.seenAt ? {} : { seenAt: new Date().toISOString() }) }, action: 'status' };
      });
      if (!state) return json(404, { error: 'request_not_found' });
      return json(200, { state: forList(state) });
    }

    if (body.action === 'addManual') {
      const v = validateManual(body, new Date());
      if (!v.ok) return json(400, { error: v.error });
      const m = v.value;
      const agreement = await currentAgreementOf(m.childUid);
      if (!(await maySubmitFor(m.parentUid, m.childUid, agreement))) return json(400, { error: 'not_linked' });
      const [parent, child, settings] = await Promise.all([loadForcaProfile(m.parentUid), loadForcaProfile(m.childUid), loadSettings()]);
      const { receipt, state } = await createRequest({
        parent, parentUid: m.parentUid, child, childUid: m.childUid, agreement,
        receivedAt: m.originalAt, channel: m.channel, requestText: m.content, note: '',
        by, enteredBy: by,
      });
      // Or entered it herself: she's seen it.
      let latest = await changeRequest(receipt.requestId, by, () => ({ patch: { seenAt: new Date().toISOString() }, action: 'seen' })) ?? state;
      if (m.notifyParent) {
        const sent = await sendParentConfirmation(parent, settings.confirmationText, receipt);
        latest = await changeRequest(receipt.requestId, { system: 'confirmation' }, () => ({
          patch: { parentNotifiedAt: new Date().toISOString() }, action: 'parent_notified', details: sent,
        })) ?? latest;
      }
      console.log(`[adminForcaCancelRequest] ${receipt.requestId} entered by ${uid}: ${m.channel}, original ${m.originalAt}`);
      return json(200, { state: forList(latest), receipt: publicReceipt(receipt) });
    }

    if (body.action === 'saveSettings') {
      const v = validateSettings(body);
      if (!v.ok) return json(400, { error: v.error });
      const basedOn = typeof body.basedOn === 'number' ? body.basedOn : (await loadSettings()).version;
      try {
        return json(200, { settings: await saveSettings(v.value, basedOn, by) });
      } catch (err: any) {
        if (err?.name === 'TransactionCanceledException') return json(409, { error: 'conflict' });
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof StateConflictError) return json(409, { error: 'conflict' });
    throw err;
  }

  return json(400, { error: 'invalid_action' });
}
