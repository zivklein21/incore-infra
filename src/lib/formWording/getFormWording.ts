import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { json } from '../http';
import { formWordingSk, isWordingFormId, normalizeTexts } from './shared';

// GET /getFormWording?brand=incore|forca&formId=health|parental_consent
// Auth: Cognito JWT, any signed-in member (the form screens read it during
// onboarding). Returns { texts, version } — texts is {} and version 0 when
// the admin never changed the wording, so the app shows its own text.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const formId = event.queryStringParameters?.formId;
  if (!isWordingFormId(formId)) return json(400, { error: 'invalid_form' });
  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' : 'incore';

  const res = await ddb.send(new GetCommand({
    TableName: tableForBrand(brand),
    Key: { PK: 'APPCONFIG', SK: formWordingSk(formId) },
  }));
  return json(200, {
    texts: normalizeTexts(res.Item?.texts) ?? {},
    version: typeof res.Item?.version === 'number' ? res.Item.version : 0,
  });
}
