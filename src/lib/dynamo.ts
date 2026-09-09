import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME as string;

// FORCA's data lives in a fully separate table (forca-production-table),
// not a brand field on shared items — absolute separation was the explicit
// requirement, not just filtering (see the FORCA data separation plan).
// Same DynamoDBClient/DocumentClient serves both — a client isn't
// table-specific, only individual requests are.
export const FORCA_TABLE_NAME = process.env.FORCA_TABLE_NAME as string;

export function tableForBrand(brand?: 'incore' | 'forca'): string {
  return brand === 'forca' ? FORCA_TABLE_NAME : TABLE_NAME;
}
