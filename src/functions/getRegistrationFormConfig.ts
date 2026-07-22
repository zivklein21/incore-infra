import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getRegistrationFormConfig
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// PK='APPCONFIG' SK='REGISTRATION_FORM_CONFIG' — same "one item per config
// type under a shared PK" convention as getSupportSettings.ts /
// notificationTiming.ts. No admin write path exists for this config yet, so
// this will return an empty section list until one is built.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: 'APPCONFIG', SK: 'REGISTRATION_FORM_CONFIG' },
  }));

  return json(200, {
    sections: Array.isArray(res.Item?.sections) ? res.Item.sections : [],
  });
}
