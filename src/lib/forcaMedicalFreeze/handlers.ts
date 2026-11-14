import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { israelDateStrOf } from '../israelTime';
import { currentAgreementOf, loadReceipt, loadState, maySubmitFor } from '../forcaCancelRequests/store';
import { CERTIFICATE_TYPES, START_REASON_LABEL, START_REASONS, checkFreezeDates, addDays } from './rules';
import {
  CertificateError, FreezeConflictError, approveFreeze, createCertificateUpload, previewMonths, rejectFreeze,
} from './store';

// FORCA medical freeze routes.
//   POST getForcaFreezeUploadUrl  { childUid, contentType, fileName } (parent) → { uploadId, uploadUrl }
// and actions on adminForcaCancelRequest (Or):
//   { action: 'certificateUploadUrl', contentType, fileName }                      → { uploadId, uploadUrl } (manual entry)
//   { action: 'freezePreview', requestId, from?, to?, startReason?, startReasonNote? } → { dates, warnings, months, error? }
//   { action: 'approveFreeze', requestId, from, to, startReason?, startReasonNote?, amounts?: { [YYYY-MM]: number }, note? }
//   { action: 'rejectFreeze', requestId, note }

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function parseBody(event: Event): Record<string, unknown> | null {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function uploadInput(body: Record<string, unknown>): { contentType: string; fileName: string } | { error: string } {
  const contentType = str(body.contentType).toLowerCase();
  if (!CERTIFICATE_TYPES[contentType]) return { error: 'file_type' };
  return { contentType, fileName: str(body.fileName) || `certificate.${CERTIFICATE_TYPES[contentType]}` };
}

export async function getForcaFreezeUploadUrl(event: Event): Promise<Result> {
  const uid = getUid(event);
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });
  const childUid = str(body.childUid);
  if (!childUid) return json(400, { error: 'missing_child' });
  if (!(await maySubmitFor(uid, childUid, await currentAgreementOf(childUid)))) return json(403, { error: 'not_your_child' });
  const input = uploadInput(body);
  if ('error' in input) return json(400, input);
  return json(200, await createCertificateUpload(uid, childUid, input.contentType, input.fileName));
}

export const startReasonOptions = START_REASONS.map((r) => ({ key: r, label: START_REASON_LABEL[r] }));

/** Or's freeze actions (already checked: admin). Returns null for an action that isn't one of these. */
export async function adminFreezeAction(body: Record<string, unknown>, by: { uid: string; name: string }): Promise<Result | null> {
  const action = body.action;
  if (action === 'certificateUploadUrl') {
    const input = uploadInput(body);
    if ('error' in input) return json(400, input);
    return json(200, await createCertificateUpload(by.uid, null, input.contentType, input.fileName));
  }
  if (action !== 'freezePreview' && action !== 'approveFreeze' && action !== 'rejectFreeze') return null;

  const requestId = str(body.requestId);
  const [state, receipt] = await Promise.all([loadState(requestId), loadReceipt(requestId)]);
  if (!state || !receipt) return json(404, { error: 'request_not_found' });
  if ((state.type ?? 'cancellation') !== 'medical_freeze') return json(400, { error: 'not_a_medical_freeze' });

  try {
    if (action === 'rejectFreeze') {
      const note = str(body.note);
      if (note.length < 2) return json(400, { error: 'note_required' });
      return json(200, { state: await rejectFreeze(requestId, by, note) });
    }

    // Not retroactive: the default start is the day the notice (with its certificate) was received.
    const receivedDay = israelDateStrOf(new Date(receipt.receivedAt));
    const raw = {
      from: body.from ?? receivedDay,
      to: body.to ?? addDays(receivedDay, 13),
      startReason: body.startReason,
      startReasonNote: body.startReasonNote,
    };
    const check = checkFreezeDates(raw, receivedDay);
    if (action === 'freezePreview') {
      if (!check.ok) return json(200, { receivedDay, dates: { from: raw.from, to: raw.to }, error: check.error, warnings: [], months: [], startReasons: startReasonOptions });
      return json(200, {
        receivedDay, dates: check.value, warnings: check.warnings, months: await previewMonths(state.childUid, check.value), startReasons: startReasonOptions,
      });
    }

    if (!check.ok) return json(400, { error: check.error });
    const amounts: Record<string, number> = {};
    if (body.amounts && typeof body.amounts === 'object') {
      for (const [month, v] of Object.entries(body.amounts as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}$/.test(month) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000) return json(400, { error: 'invalid_amount' });
        amounts[month] = Math.round(v * 100) / 100;
      }
    }
    const note = str(body.note) || undefined;
    const saved = await approveFreeze(requestId, check.value, check.warnings.map((w) => w.message), amounts, by, note);
    return json(200, { state: saved });
  } catch (err) {
    if (err instanceof FreezeConflictError) return json(409, { error: err.code });
    if (err instanceof CertificateError) return json(400, { error: err.code });
    throw err;
  }
}
