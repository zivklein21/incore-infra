import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getOrthopedicFormConfig?brand=incore|forca
// Auth: Cognito JWT (any signed-in member — same as getRegistrationFormConfig.ts)
//
// PK='APPCONFIG' SK='ORTHOPEDIC_FORM_CONFIG' — same "one item per config
// type under a shared PK" convention as getRegistrationFormConfig.ts, but
// brand-aware from the start (tableForBrand) since this form is FORCA-born
// and FORCA data must live in FORCA_TABLE_NAME, not bleed into TABLE_NAME.
// Defaults to 'incore' for callers that don't pass brand.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran

  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const res = await ddb.send(new GetCommand({
    TableName: tableForBrand(brand),
    Key: { PK: 'APPCONFIG', SK: 'ORTHOPEDIC_FORM_CONFIG' },
  }));

  return json(200, {
    sections: Array.isArray(res.Item?.sections) ? res.Item.sections : [],
  });
}
