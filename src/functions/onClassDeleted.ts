import type { DynamoDBStreamEvent } from 'aws-lambda';
import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { oldImage } from '../lib/dynamoStream';
import type { ClassItem, RegistrationItem } from '../lib/entities';
import { extractMemberIds, writeNotification, getMemberProfile } from '../lib/classNotifications';
import { resolveTemplate, getMemberLang, fmtTime, fmtDate, type TemplateVars } from '../lib/templateResolver';

// DynamoDB Stream trigger — fires on REMOVE of a PK=CLASS#<id> SK=METADATA
// item. Deleting the class item does NOT cascade-delete its Registration
// items (same PK partition, different SK) — this refunds whatever each
// booked member consumed, then sends the CLASS_CANCEL notification, exactly
// like a legal cancellation but without legal/late bookkeeping (it's not the
// member's cancellation to charge against their monthly allowance).
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE') continue;
    const classItem = oldImage<ClassItem>(record);
    if (!classItem || classItem.SK !== 'METADATA' || !classItem.PK.startsWith('CLASS#')) continue;

    const classId = classItem.PK.replace('CLASS#', '');
    const classDate = new Date(classItem.date);
    const classType = classItem.className ?? '';

    // Must run before the refund step below — that step deletes the very
    // REGISTERED items this reads to build the notification list.
    const memberIds = await extractMemberIds(classId, classItem);

    await refundBookedRegistrations(classId);

    if (memberIds.length === 0) continue;

    await Promise.all(memberIds.map(async (memberId) => {
      const profile = await getMemberProfile(memberId);
      if (!profile) return;
      const lang = getMemberLang(profile);
      const vars: TemplateVars = {
        class_type: classType,
        class_time: fmtTime(classDate),
        class_date: fmtDate(classDate, lang),
        member_name: profile.name ?? '',
      };
      const resolved = await resolveTemplate('CLASS_CANCEL', lang, vars);
      if (!resolved) return;
      await writeNotification(memberId, classId, classType, classDate, resolved, 'cancel');
    }));

    console.log(`[onClassDeleted] class=${classId} — notified ${memberIds.length} members`);
  }
}

async function refundBookedRegistrations(classId: string): Promise<void> {
  const regsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :registered',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];

  await Promise.all(registrations.map(async (reg) => {
    const uid = reg.userId;
    if (!uid) return;

    const isMembershipBased = reg.consumedFrom === 'MEMBERSHIP' || reg.consumedFrom === 'FUTURE_SUBSCRIPTION';
    const refundTo: 'none' | 'wallet' | 'membership' =
      isMembershipBased ? 'membership' :
      (reg.consumedFrom === 'EXTRA_PUNCH' || reg.consumedFrom === 'ADMIN_CARD') ? 'wallet' :
      'none';

    const nowIso = new Date().toISOString();
    const cancelPayload: Record<string, unknown> = {
      PK: `MEMBER#${uid}`,
      SK: `CANCEL#${classId}`,
      classId,
      status: 'ADMIN_CANCELLED',
      consumedFrom: reg.consumedFrom ?? '',
      membershipId: reg.membershipId ?? '',
      adminCardId: reg.adminCardId ?? null,
      weekKey: reg.weekKey ?? null,
      targetMonth: reg.targetMonth ?? '',
      cancelledAt: nowIso,
      adminCancelled: true,
      reason: 'class_deleted',
      refundTo,
    };

    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Delete: { TableName: TABLE_NAME, Key: { PK: reg.PK, SK: reg.SK } } },
      { Put: { TableName: TABLE_NAME, Item: cancelPayload } },
    ];

    if (refundTo === 'wallet') {
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' },
          UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
          ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
        },
      });
    } else if (refundTo === 'membership' && reg.membershipId) {
      const wKey = reg.weekKey;
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${reg.targetMonth}#${reg.membershipId}` },
          // usage is a DynamoDB reserved keyword — bare here it fails every call.
          UpdateExpression: wKey
            ? 'ADD #usage.totalMonthlyUsed :negOne, weeklyUsage.#wk :negOne SET updatedAt = :now'
            : 'ADD #usage.totalMonthlyUsed :negOne SET updatedAt = :now',
          ExpressionAttributeNames: wKey ? { '#wk': wKey, '#usage': 'usage' } : { '#usage': 'usage' },
          ExpressionAttributeValues: { ':negOne': -1, ':now': nowIso },
        },
      });
    }

    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err: any) {
      console.error(`[refundBookedRegistrations] class=${classId} user=${uid} failed`, err);
    }
  }));

  console.log(`[refundBookedRegistrations] class=${classId} — refunded ${registrations.length} registrations`);
}
