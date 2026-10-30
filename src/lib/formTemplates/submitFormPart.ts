import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { deriveMemberName } from '../entities';
import { SIGNER_ROLES, SignerRole } from './schema';
import { formAssignmentKey, formSubmissionPk } from './shared';
import { Answers, answerFormatError, canFill, detailsKey, FieldAnswer, missingRequired, pruneHidden } from './logic';
import { notifyNextSigner, participatingRoles, resolveFamilyCaller, rolesOnDevice } from './familyForms';
import {
  computeSubmissionStatus, FormAssignmentItem, formsTable, FormSubmissionItem, getProfile, getTemplateHead, getTemplateVersion,
  latestByAssignment, listSubmissionsOfChild, parentOf, targetIncludes, versionToSign,
} from './submissions';
import type { SignatureRecord } from './pdf/renderFormPdf';
import { ensureSignedPdf } from './signedPdf';
import { rememberPrefill } from './prefill';
import { writeAudit } from './audit';

// POST /submitFormPart
// Body: { templateId, assignmentId, childId?, role: 'parent'|'trainee',
//         answers: { [fieldId]: value, [fieldId:details]: string },
//         signatures: { [signatureFieldId]: { paths: string[], typedName: string } },
//         acknowledge?: true }
// Auth: Cognito JWT — the parent (childId = her linked child) or the trainee
// herself, and only for a role whose part may be done on that device
// (familyForms.rolesOnDevice). One call = one signer's whole part: their
// fields, their declarations (every required item ticked) and their
// signature block(s). The server sets the signing time (never the client);
// the only other thing recorded is which device it was signed on — the
// parent's or the trainee's — no IP, user agent or device id. A part
// can't be signed twice; once every required signer (and acknowledger) is
// done the submission is Completed and its PDF is generated and stored.
//
// 400 { error: 'missing_required', fieldIds } / { error: 'invalid_answer', fieldId, reason }.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  let body: {
    templateId?: unknown; assignmentId?: unknown; childId?: unknown; role?: unknown;
    answers?: unknown; signatures?: unknown; acknowledge?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : '';
  const role = (SIGNER_ROLES as readonly string[]).includes(body.role as string) ? body.role as SignerRole : null;
  if (!templateId || !assignmentId || !role) return json(400, { error: 'missing_fields' });

  const caller = await resolveFamilyCaller(uid, typeof body.childId === 'string' ? body.childId : undefined);
  if (!caller) return json(403, { error: 'forbidden' });

  const [head, assignmentRes, child, subs] = await Promise.all([
    getTemplateHead(caller.brand, templateId),
    ddb.send(new GetCommand({ TableName: formsTable(caller.brand), Key: formAssignmentKey(templateId, assignmentId) })),
    getProfile(caller.brand, caller.childId),
    listSubmissionsOfChild(caller.brand, caller.childId),
  ]);
  const assignment = assignmentRes.Item as FormAssignmentItem | undefined;
  if (!head || head.status !== 'published' || !assignment || assignment.cancelledAt || !child) return json(404, { error: 'not_found' });
  if (!targetIncludes(assignment.target, { uid: caller.childId, groupId: child.identity?.groupId, createdAt: (child as { createdAt?: string }).createdAt }, assignment.createdAt)) {
    return json(404, { error: 'not_found' });
  }

  const existing = latestByAssignment(subs, caller.childId).get(assignmentId);
  const { version, reuse } = versionToSign(head, existing);
  const t = await getTemplateVersion(caller.brand, templateId, version);
  if (!t) return json(404, { error: 'not_found' });
  const prev = reuse ? existing : undefined;

  if (!rolesOnDevice(caller.device, participatingRoles(t), t.traineeDevice, caller.brand).includes(role)) return json(403, { error: 'wrong_device' });

  const signedRoles = [...(prev?.signedRoles ?? [])];
  const ackRoles = [...(prev?.ackRoles ?? [])];
  const before = computeSubmissionStatus({ signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion, signedRoles, ackRoles, version });
  if (before.status === 'completed') return json(409, { error: 'already_completed' });

  const now = new Date().toISOString();
  const device = caller.device;
  const signerProfile = role === 'trainee' ? child : await getProfile(caller.brand, caller.device === 'parent_phone' ? caller.uid : (await parentOf(caller.brand, caller.childId)) ?? '');
  const sub: FormSubmissionItem = prev ? { ...prev, answers: { ...prev.answers }, answeredBy: { ...prev.answeredBy }, signatures: [...prev.signatures], acknowledgments: [...prev.acknowledgments] } : (() => {
    const submissionId = randomUUID();
    return {
      PK: formSubmissionPk(templateId), SK: `${caller.childId}#${assignmentId}#${now}`,
      GSI1PK: `MEMBER#${caller.childId}`, GSI1SK: `FORMSUB#${templateId}#${assignmentId}#${now}`,
      brand: caller.brand, submissionId, templateId, assignmentId, childId: caller.childId, version,
      answers: {}, answeredBy: {}, signatures: [], acknowledgments: [], signedRoles: [], ackRoles: [],
      status: before.status, createdAt: now, updatedAt: now,
    };
  })();

  if (body.acknowledge === true) {
    // View & acknowledge: only once every signer signed, only by an acknowledger.
    if (!t.acknowledgers.includes(role)) return json(400, { error: 'not_an_acknowledger' });
    if (ackRoles.includes(role)) return json(409, { error: 'already_signed' });
    if (t.signers.some(r => !signedRoles.includes(r))) return json(409, { error: 'waiting_for_signers' });
    sub.acknowledgments.push({ role, userId: uid, name: signerProfile ? deriveMemberName(signerProfile) : '', at: now, device, version });
    ackRoles.push(role);
  } else {
    if (signedRoles.includes(role)) return json(409, { error: 'already_signed' });
    if (t.acknowledgers.includes(role)) return json(400, { error: 'acknowledger_cannot_sign' });

    // Admin-filled answers are the assignment's, always — nobody else writes them.
    const answers: Answers = { ...sub.answers, ...assignment.adminAnswers };
    const answeredBy = { ...sub.answeredBy };
    const incoming = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, FieldAnswer>;
    const fields = t.sections.flatMap(s => s.fields);
    for (const f of fields) {
      if (f.type === 'signature' || !canFill(f, role, answeredBy)) continue;
      if (f.id in incoming) {
        const value = incoming[f.id];
        const error = answerFormatError(f, value);
        if (error) return json(400, { error: 'invalid_answer', fieldId: f.id, reason: error });
        if (value === undefined || value === null || value === '') delete answers[f.id];
        else { answers[f.id] = value; answeredBy[f.id] = role; }
      }
      if (f.type === 'yes_no' && f.detailsLabel && detailsKey(f.id) in incoming) {
        const details = incoming[detailsKey(f.id)];
        if (typeof details === 'string' && details.trim()) answers[detailsKey(f.id)] = details.trim().slice(0, 5000);
        else delete answers[detailsKey(f.id)];
      }
    }

    // Signatures — this role's blocks only; the time is the server's.
    const rawSigs = (body.signatures && typeof body.signatures === 'object' ? body.signatures : {}) as Record<string, { paths?: unknown; typedName?: unknown }>;
    const newSigs: SignatureRecord[] = [];
    const withSigs: Answers = { ...answers };
    for (const f of fields.filter(x => x.type === 'signature' && x.filledBy === role)) {
      const raw = rawSigs[f.id];
      if (!raw) continue;
      const value = { paths: Array.isArray(raw.paths) ? raw.paths : [], typedName: typeof raw.typedName === 'string' ? raw.typedName.trim().slice(0, 120) : '' };
      const error = answerFormatError(f, value as FieldAnswer);
      if (error) return json(400, { error: 'invalid_answer', fieldId: f.id, reason: error });
      withSigs[f.id] = value as FieldAnswer;
      newSigs.push({ fieldId: f.id, role, userId: uid, name: value.typedName, paths: value.paths as string[], signedAt: now, device, version });
    }

    const missing = missingRequired(t.sections, withSigs, role, answeredBy);
    if (missing.length) return json(400, { error: 'missing_required', fieldIds: missing.map(f => f.id) });

    sub.answers = pruneHidden(t.sections, answers);
    sub.answeredBy = answeredBy;
    sub.signatures.push(...newSigs);
    signedRoles.push(role);
  }

  const after = computeSubmissionStatus({ signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion, signedRoles, ackRoles, version });
  sub.signedRoles = signedRoles;
  sub.ackRoles = ackRoles;
  sub.status = after.status;
  sub.updatedAt = now;
  if (after.status === 'completed') sub.completedAt = now;

  try {
    await ddb.send(new PutCommand({
      TableName: formsTable(caller.brand),
      Item: sub,
      ...(prev
        ? { ConditionExpression: 'updatedAt = :prev', ExpressionAttributeValues: { ':prev': prev.updatedAt } }
        : { ConditionExpression: 'attribute_not_exists(SK)' }),
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return json(409, { error: 'conflict' });
    throw err;
  }

  await writeAudit(caller.brand, { action: body.acknowledge === true ? 'acknowledge' : 'sign', templateId, submissionId: sub.submissionId, childId: caller.childId, actorUid: uid, detail: { role, version, device } });

  if (after.status === 'completed') {
    await writeAudit(caller.brand, { action: 'complete', templateId, submissionId: sub.submissionId, childId: caller.childId, actorUid: uid, detail: { version } });
    try {
      await ensureSignedPdf(caller.brand, sub, uid);
    } catch (err) {
      // The submission is complete regardless; the PDF is (re)generated on the first download.
      console.error('[submitFormPart] PDF generation failed', sub.submissionId, err);
    }
  } else {
    await notifyNextSigner(caller.brand, sub, after.missing.filter(r => r !== role), t.name);
  }

  if (body.acknowledge !== true) {
    const parentUid = caller.device === 'parent_phone' ? caller.uid : await parentOf(caller.brand, caller.childId);
    await rememberPrefill({
      fields: t.sections.flatMap(s => s.fields).filter(f => sub.answeredBy[f.id] === role),
      answers: sub.answers,
      child: { table: formsTable(caller.brand), uid: caller.childId },
      parent: parentUid ? { table: formsTable(caller.brand), uid: parentUid } : null,
    });
  }

  return json(200, { success: true, submissionId: sub.submissionId, status: after.status, signedAt: now });
}
