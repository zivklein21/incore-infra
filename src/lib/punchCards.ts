import { randomUUID } from 'crypto';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';

// Creates the standalone PunchCardItem only — the shape bookClass/
// cancelBooking/confirmWaitlistSpot/etc. all read for available-credit
// checks. Every punch-card grant path writes this; some paths additionally
// mirror it into the legacy extra.punch_cards array (see below) and some
// don't — that distinction is preserved from the three different original
// Firebase call sites, not something introduced in this port.
export async function putPunchCardItem(params: {
  memberId: string;
  cardId: string;
  remainingPunches: number;
  expiryDate: string | null;
  notes: string;
  source: string;
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${params.memberId}`,
      SK: `PUNCHCARD#${params.cardId}`,
      cardId: params.cardId,
      remainingPunches: params.remainingPunches,
      expiryDate: params.expiryDate,
      notes: params.notes,
      source: params.source,
    },
  }));
}

// Mirrors a grant into the legacy members/{id}.extra.punch_cards array —
// still read directly by StoreScreen. Only some grant paths do this (see
// functions/src/products.ts grantPunchCard/autoGrantProduct); paymentGrants.ts's
// grantPunchCardSessions deliberately never did.
export async function appendLegacyPunchCard(memberId: string, legacyCard: Record<string, unknown>): Promise<void> {
  const memberRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
  }));
  const existingCards = (memberRes.Item as MemberProfileItem | undefined)?.extra?.punch_cards ?? [];

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: 'SET extra = :extra',
    ExpressionAttributeValues: { ':extra': { punch_cards: [...existingCards, legacyCard] } },
  }));
}

export interface GrantPunchCardParams {
  memberId: string;
  productId: string;
  productName: string;
  sessions: number;
  cardType: 'mid_month' | 'extra_class';
  expiresAt: Date | null;
  source: string;
}

// Writes both the legacy array and the standalone PunchCardItem — used by
// products.ts's grantPunchCard (admin) and autoGrantProduct (Make.com webhook).
export async function grantPunchCardToMember(params: GrantPunchCardParams): Promise<string> {
  const { memberId, productId, productName, sessions, cardType, expiresAt, source } = params;
  const cardId = randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAtIso = expiresAt ? expiresAt.toISOString() : null;

  await appendLegacyPunchCard(memberId, {
    id: cardId,
    type: cardType,
    source_product_id: productId,
    name: productName,
    balance: sessions,
    purchased_at: nowIso,
    expires_at: expiresAtIso,
  });

  await putPunchCardItem({ memberId, cardId, remainingPunches: sessions, expiryDate: expiresAtIso, notes: productName, source });

  return cardId;
}
