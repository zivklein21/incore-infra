import type { DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';

// A single DynamoDB table (single-table design) means its Stream carries
// change events for EVERY entity type — Registrations, Classes,
// Memberships, Wallets, Messages, etc. — not just the one collection a
// Firestore trigger used to be scoped to. Every stream-triggered Lambda in
// this batch MUST filter by PK/SK pattern for its own entity type and
// return early for everything else. (The Terraform event source mapping
// also applies a FilterCriteria to cut invocation volume, but the Lambda
// still checks defensively — filters are cheap, a missed one is not.)

export function newImage<T>(record: DynamoDBRecord): T | null {
  const raw = record.dynamodb?.NewImage;
  if (!raw) return null;
  return unmarshall(raw as Record<string, any>) as T;
}

export function oldImage<T>(record: DynamoDBRecord): T | null {
  const raw = record.dynamodb?.OldImage;
  if (!raw) return null;
  return unmarshall(raw as Record<string, any>) as T;
}
