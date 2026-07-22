import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /submitHealthDeclaration
// Auth: Cognito JWT (any signed-in member)
// Body: { idNumber, name, answers, pdfKey?, doctorApprovalKey? }
//
// pdfKey/doctorApprovalKey are S3 object keys (see getUploadUrl.ts) — the
// client uploads directly to S3 first, then passes the resulting key here.
// Both optional since upload itself is best-effort in the client (saves the
// declaration without them if the upload step fails).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: {
    idNumber?: unknown; name?: unknown; answers?: unknown;
    pdfKey?: unknown; doctorApprovalKey?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const idNumber = typeof body.idNumber === 'string' ? body.idNumber : '';
  const name = typeof body.name === 'string' ? body.name : '';
  const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};

  const key = { PK: `MEMBER#${uid}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const healthDeclaration: Record<string, unknown> = {
    submitted_at: new Date().toISOString(),
    id_number: idNumber,
    name,
    answers,
  };
  if (typeof body.pdfKey === 'string' && body.pdfKey) healthDeclaration.pdf_key = body.pdfKey;
  if (typeof body.doctorApprovalKey === 'string' && body.doctorApprovalKey) {
    healthDeclaration.doctor_approval_key = body.doctorApprovalKey;
  }

  const forms = {
    ...(profile.forms ?? {}),
    health_form: true,
    health_declaration: healthDeclaration,
  };

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
