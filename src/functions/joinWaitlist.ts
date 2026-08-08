import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, MembershipItem, PunchCardItem, WalletItem, WaitlistEntry } from '../lib/entities';
import { monthKey, isMembershipUsableForClass } from '../lib/entities';

function hasAnyUsableCredit(
  membership: MembershipItem | null,
  extraPunches: number,
  adminPunchCards: PunchCardItem[],
  classDate: Date,
): boolean {
  if (membership) return true;
  if (extraPunches > 0) return true;
  return adminPunchCards.some((c) => c.remainingPunches > 0 && (!c.expiryDate || new Date(c.expiryDate) >= classDate));
}

// POST /joinWaitlist
// Auth: Cognito JWT (any signed-in member)
// Body: { classId }
//
// Read-modify-write on ClassItem.waitlist, same as the original Firestore
// updateDoc(classRef, { waitlist: [...] }) — not a TransactWriteItems
// conditional update, so it carries the same theoretical concurrent-join
// race the Firestore version had (two members joining in the same instant
// could each read the pre-join array). Not worth a bigger redesign to close
// a race no worse than what already shipped.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const key = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const item = res.Item as ClassItem | undefined;
  if (!item) return json(404, { error: 'class_not_found' });
  if (!item.isWaitlistEnabled) return json(400, { error: 'waitlist_not_allowed' });

  // Joining a waitlist only makes sense if there's some way to actually
  // claim the spot if one opens up — confirmWaitlistSpot.ts already blocks
  // the final confirm for a member with nothing usable, but without this
  // check they could join, get notified a spot is open, and then fail to
  // claim it. Deliberately lenient here vs. confirmWaitlistSpot's strict
  // weekly/monthly quota check: quota can reset between now and whenever a
  // spot actually opens, so "has an active membership at all" is enough to
  // let them join — the strict check happens again at confirm time.
  const classDate = new Date(item.date);
  const targetMonth = monthKey(classDate);
  const [membershipsRes, walletRes, cardsRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': `MEMBERSHIP#${targetMonth}#` },
    })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' } })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'PUNCHCARD#' },
    })),
  ]);
  const membership = ((membershipsRes.Items ?? []) as MembershipItem[]).find((m) => isMembershipUsableForClass(m, classDate)) ?? null;
  const extraPunches = (walletRes.Item as WalletItem | undefined)?.extraPunches ?? 0;
  const adminPunchCards = (cardsRes.Items ?? []) as PunchCardItem[];

  if (!hasAnyUsableCredit(membership, extraPunches, adminPunchCards, classDate)) {
    return json(403, { error: 'membership_required', message: 'You need an active membership or available credit to join the waitlist.' });
  }

  const filtered = (item.waitlist ?? []).filter((e) => e.member !== uid);
  const newEntry: WaitlistEntry = { member: uid, since: new Date().toISOString(), status: 'waiting' };
  const waitlist = [...filtered, newEntry];

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET waitlist = :waitlist',
    ExpressionAttributeValues: { ':waitlist': waitlist },
  }));

  return json(200, { success: true });
}
