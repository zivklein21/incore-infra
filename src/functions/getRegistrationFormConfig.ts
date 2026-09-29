import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getRegistrationFormConfig?brand=incore|forca
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// PK='APPCONFIG' SK='REGISTRATION_FORM_CONFIG' — same "one item per config
// type under a shared PK" convention as getSupportSettings.ts /
// notificationTiming.ts, and the same brand-aware split (tableForBrand)
// getOrthopedicFormConfig.ts already uses — INCORE and FORCA each get their
// own independently-editable question set now, rather than one shared
// config that used to live only in TABLE_NAME/INCORE (FORCA registrants
// were unknowingly filling INCORE's own questions). Defaults to 'incore'
// for callers that don't pass brand, same as getOrthopedicFormConfig.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const res = await ddb.send(new GetCommand({
    TableName: tableForBrand(brand),
    Key: { PK: 'APPCONFIG', SK: 'REGISTRATION_FORM_CONFIG' },
  }));

  return json(200, {
    sections: Array.isArray(res.Item?.sections) ? res.Item.sections : [],
  });
}
