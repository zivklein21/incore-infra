import { S3Client } from '@aws-sdk/client-s3';

export const s3 = new S3Client({});
export const BUCKET_NAME = process.env.BUCKET_NAME as string;
