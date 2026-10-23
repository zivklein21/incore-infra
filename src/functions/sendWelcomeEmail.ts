import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';
import { appWelcomeEmailSubject, buildAppWelcomeEmailHtml } from '../lib/appWelcomeEmail';

// POST /sendWelcomeEmail
// Body: ignored (older app builds still send { to, subject, html })
// Auth: Cognito JWT (any signed-in member)
//
// Queues the post-registration "welcome, the app awaits you" email for the
// CALLER — always to their own profile email, with the server-built template
// (lib/appWelcomeEmail.ts). It used to queue whatever to/subject/html the
// client sent, which made it an open relay: any signed-in member could send
// arbitrary HTML from our sender to any address.
//
// Queues a PK=MAIL#<id> item — processMail.ts's DynamoDB Streams trigger
// sends it (lib/mailer.ts) and deletes the item.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const to = (profile.identity?.email ?? profile.email ?? '').trim();
  if (!to) return json(400, { error: 'missing_email' });
  const brand: 'incore' | 'forca' = table === FORCA_TABLE_NAME || profile.identity?.brand === 'forca' ? 'forca' : 'incore';

  const id = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MAIL#${id}`, SK: 'METADATA', to, brand,
      message: { subject: appWelcomeEmailSubject(brand), html: buildAppWelcomeEmailHtml(brand) },
    },
  }));

  return json(200, { success: true });
}
