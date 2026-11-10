import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { deriveMemberName, type FamilyLinkItem, type GroupItem, type MemberProfileItem } from '../entities';
import { listForcaCoaches, resolveChatCaller } from './store';

// GET /getForcaChatContacts (shared integration)
// Who the caller can start a conversation with.
//   trainee: { people: [herself with her group's coaches] }
//   parent:  { people: [each linked child with that child's group's coaches] }
//   admin:   { coaches: every coach } (for the inbox's per-coach filter)
// Coaches don't start conversations: 403.
export async function getForcaChatContacts(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const caller = await resolveChatCaller(getUid(event));

  if (caller.isAdmin) {
    const coaches = await listForcaCoaches();
    return json(200, { coaches: coaches.map((c) => ({ uid: c.uid, name: c.name, groupIds: c.groupIds })) });
  }
  if (caller.coachGroupIds || !caller.profile) return json(403, { error: 'forbidden' });

  let people: { uid: string; profile: MemberProfileItem; isSelf: boolean }[];
  if (caller.profile.identity?.accountType === 'parent_only') {
    const links = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :family)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${caller.uid}`, ':family': 'FAMILY#' },
    }));
    const childUids = ((links.Items ?? []) as FamilyLinkItem[]).map((l) => l.childUid);
    const profiles = await Promise.all(childUids.map(async (uid) => {
      const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
      return res.Item ? { uid, profile: res.Item as MemberProfileItem, isSelf: false } : null;
    }));
    people = profiles.filter((p): p is NonNullable<typeof p> => !!p);
  } else {
    people = [{ uid: caller.uid, profile: caller.profile, isSelf: true }];
  }

  const groupIds = Array.from(new Set(people.map((p) => p.profile.identity?.groupId).filter((g): g is string => !!g)));
  const [coaches, groups] = await Promise.all([
    groupIds.length ? listForcaCoaches() : Promise.resolve([]),
    Promise.all(groupIds.map(async (g) => {
      const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${g}`, SK: 'METADATA' } }));
      return [g, (res.Item as GroupItem | undefined)?.name ?? ''] as const;
    })),
  ]);
  const groupName = new Map(groups);

  return json(200, {
    people: people.map(({ uid, profile, isSelf }) => {
      const groupId = profile.identity?.groupId ?? null;
      return {
        uid,
        name: deriveMemberName(profile),
        isSelf,
        groupId,
        groupName: groupId ? groupName.get(groupId) ?? '' : null,
        coaches: groupId ? coaches.filter((c) => c.groupIds.includes(groupId)).map((c) => ({ uid: c.uid, name: c.name })) : [],
      };
    }),
  });
}
